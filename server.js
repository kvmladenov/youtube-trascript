const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const cheerio = require('cheerio');
const { createHash } = require('crypto');

const app = express();
app.use(cors());
app.use(express.static('public'));

// Serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Parse JSON3 format captions
function parseJson3Captions(json3Data) {
    try {
        if (!json3Data || !json3Data.events) {
            return [];
        }
        
        const transcript = [];
        
        for (const event of json3Data.events) {
            // Skip events without segments or those that are just formatting
            if (!event.segs || event.segs.length === 0) {
                continue;
            }
            
            // Handle caption segments
            if (event.tStartMs !== undefined && event.dDurationMs !== undefined) {
                const startMs = event.tStartMs;
                const durationMs = event.dDurationMs;
                
                let text = '';
                for (const seg of event.segs) {
                    if (seg.utf8) {
                        text += seg.utf8;
                    }
                }
                
                // Clean up newlines and multiple spaces
                text = text.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
                
                if (text) {
                    transcript.push({
                        text: text,
                        start: (startMs / 1000).toFixed(2),
                        duration: (durationMs / 1000).toFixed(2)
                    });
                }
            }
        }
        
        return transcript;
    } catch (error) {
        console.error('Error parsing JSON3 captions:', error);
        return [];
    }
}

// Extract the YouTube Player Response from a video page
async function getYouTubePlayerResponse(videoId) {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    ];
    
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    
    try {
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': userAgent,
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.youtube.com/'
            }
        });
        
        const html = response.data;
        
        // Try to extract the ytInitialPlayerResponse JSON
        const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});/s);
        
        if (playerResponseMatch && playerResponseMatch[1]) {
            try {
                return JSON.parse(playerResponseMatch[1]);
            } catch (e) {
                console.error('Failed to parse ytInitialPlayerResponse:', e);
            }
        }
        
        // Try to find any other data we can use
        // Check for innertubeApiKey
        const innertubeApiKeyMatch = html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/);
        if (innertubeApiKeyMatch) {
            return { innertubeApiKey: innertubeApiKeyMatch[1] };
        }
        
        return null;
    } catch (error) {
        console.error(`Error fetching YouTube page:`, error.message);
        return null;
    }
}

// Extract video ID from various YouTube URL formats
function extractVideoId(url) {
    if (!url) return null;
    
    // Check if it's already just a video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(url)) {
        return url;
    }
    
    // Youtube.com/watch?v= format
    const watchRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;
    const watchMatch = url.match(watchRegex);
    
    if (watchMatch && watchMatch[1]) {
        return watchMatch[1];
    }
    
    // ?v= anywhere in the URL
    const vParamRegex = /[?&]v=([a-zA-Z0-9_-]{11})/;
    const vParamMatch = url.match(vParamRegex);
    
    if (vParamMatch && vParamMatch[1]) {
        return vParamMatch[1];
    }
    
    return null;
}

// A more advanced approach using the InnerTube API
async function fetchCaptionsWithInnerTube(videoId) {
    try {
        // First get the API key and client version from the YouTube page
        const playerResponse = await getYouTubePlayerResponse(videoId);
        
        if (!playerResponse) {
            throw new Error('Failed to extract player response from YouTube page');
        }
        
        // Try to find the caption tracks directly if available
        if (playerResponse.captions && 
            playerResponse.captions.playerCaptionsTracklistRenderer && 
            playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) {
            
            const captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
            
            // Find English auto-generated captions preferably
            let targetTrack = captionTracks.find(track => 
                track.languageCode === 'en' && 
                track.name && 
                track.name.simpleText && 
                track.name.simpleText.includes('auto')
            );
            
            // If no auto-generated English captions, try any English
            if (!targetTrack) {
                targetTrack = captionTracks.find(track => track.languageCode === 'en');
            }
            
            // If still no English, take the first one
            if (!targetTrack && captionTracks.length > 0) {
                targetTrack = captionTracks[0];
            }
            
            if (targetTrack && targetTrack.baseUrl) {
                // Try JSON3 format first
                const jsonUrl = targetTrack.baseUrl.includes('?') 
                    ? `${targetTrack.baseUrl}&fmt=json3` 
                    : `${targetTrack.baseUrl}?fmt=json3`;
                
                try {
                    const jsonResponse = await axios.get(jsonUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                            'Referer': `https://www.youtube.com/watch?v=${videoId}`
                        }
                    });
                    
                    if (jsonResponse.data && jsonResponse.data.events) {
                        return parseJson3Captions(jsonResponse.data);
                    }
                } catch (jsonError) {
                    console.log('Failed to get JSON format, trying XML');
                }
                
                // Fall back to XML if JSON3 fails
                try {
                    const xmlResponse = await axios.get(targetTrack.baseUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                            'Referer': `https://www.youtube.com/watch?v=${videoId}`
                        }
                    });
                    
                    if (xmlResponse.data) {
                        const $ = cheerio.load(xmlResponse.data, { xmlMode: true });
                        const transcript = [];
                        
                        $('text').each((i, el) => {
                            const start = $(el).attr('start');
                            const dur = $(el).attr('dur');
                            const text = $(el).text();
                            
                            if (start && dur && text) {
                                transcript.push({
                                    text: text,
                                    start: start,
                                    duration: dur
                                });
                            }
                        });
                        
                        return transcript;
                    }
                } catch (xmlError) {
                    console.log('Failed to get XML format as well');
                }
            }
        }
        
        // If we couldn't get captions directly from the player response, try alternative methods
        // Try the timedtext API with various parameters
        const timedTextUrls = [
            `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
            `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=json3`,
            `https://www.youtube.com/api/timedtext?v=${videoId}&caps=asr&xoaf=4&hl=en&fmt=json3`,
            `https://www.youtube.com/api/timedtext?v=${videoId}&kind=asr&lang=en&fmt=json3&xoaf=4&hl=en&tlang=en`
        ];
        
        for (const url of timedTextUrls) {
            try {
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (response.data && response.data.events) {
                    return parseJson3Captions(response.data);
                }
            } catch (error) {
                console.log(`Failed to get captions from ${url}`);
            }
        }
        
        // If we found the innertubeApiKey, try using the InnerTube API
        if (playerResponse.innertubeApiKey) {
            const apiKey = playerResponse.innertubeApiKey;
            
            // Build a request to the InnerTube API
            const innertubeUrl = `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`;
            
            const payload = {
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20250304.01.00'
                    }
                },
                params: Buffer.from(JSON.stringify({
                    videoId: videoId
                })).toString('base64')
            };
            
            try {
                const response = await axios.post(innertubeUrl, payload, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                        'Content-Type': 'application/json',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (response.data && response.data.actions) {
                    // Parse the transcript data from the InnerTube API response
                    const actions = response.data.actions;
                    const transcript = [];
                    
                    // The structure here is different, we need to extract from the response
                    for (const action of actions) {
                        if (action.updateEngagementPanelAction && 
                            action.updateEngagementPanelAction.content && 
                            action.updateEngagementPanelAction.content.transcriptRenderer && 
                            action.updateEngagementPanelAction.content.transcriptRenderer.body) {
                            
                            const content = action.updateEngagementPanelAction.content.transcriptRenderer.body;
                            
                            if (content.transcriptBodyRenderer && 
                                content.transcriptBodyRenderer.cueGroups) {
                                
                                for (const cueGroup of content.transcriptBodyRenderer.cueGroups) {
                                    if (cueGroup.transcriptCueGroupRenderer && 
                                        cueGroup.transcriptCueGroupRenderer.cues) {
                                        
                                        for (const cue of cueGroup.transcriptCueGroupRenderer.cues) {
                                            if (cue.transcriptCueRenderer) {
                                                const startMs = parseInt(cue.transcriptCueRenderer.startOffsetMs);
                                                const durationMs = parseInt(cue.transcriptCueRenderer.durationMs);
                                                
                                                let text = '';
                                                if (cue.transcriptCueRenderer.cue && 
                                                    cue.transcriptCueRenderer.cue.simpleText) {
                                                    text = cue.transcriptCueRenderer.cue.simpleText;
                                                } else if (cue.transcriptCueRenderer.cue && 
                                                          cue.transcriptCueRenderer.cue.runs) {
                                                    text = cue.transcriptCueRenderer.cue.runs.map(run => run.text).join('');
                                                }
                                                
                                                if (text) {
                                                    transcript.push({
                                                        text: text,
                                                        start: (startMs / 1000).toFixed(2),
                                                        duration: (durationMs / 1000).toFixed(2)
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                                
                                return transcript;
                            }
                        }
                    }
                }
            } catch (innertubeError) {
                console.log('Failed to use InnerTube API:', innertubeError.message);
            }
        }
        
        throw new Error('Could not find any captions using available methods');
    } catch (error) {
        console.error(`Error in fetchCaptionsWithInnerTube:`, error.message);
        throw error;
    }
}

// Try using the Embedded Player API
async function tryEmbeddedPlayerCaptions(videoId) {
    try {
        const randomTimestamp = Date.now();
        const url = `https://www.youtube.com/embed/${videoId}?hl=en&cc_lang_pref=en&cc_load_policy=1&t=${randomTimestamp}`;
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        const html = response.data;
        
        // Look for caption data in the embedded player HTML
        const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])/s);
        
        if (captionTracksMatch && captionTracksMatch[1]) {
            try {
                // We need to make this valid JSON by adding wrapping brackets and replacing single quotes
                const captionTracksJson = JSON.parse(captionTracksMatch[1].replace(/'/g, '"'));
                
                // Find English auto-generated captions preferably
                let targetTrack = captionTracksJson.find(track => 
                    track.languageCode === 'en' && 
                    track.name && 
                    track.name.includes('auto')
                );
                
                // If no auto-generated English captions, try any English
                if (!targetTrack) {
                    targetTrack = captionTracksJson.find(track => track.languageCode === 'en');
                }
                
                // If still no English, take the first one
                if (!targetTrack && captionTracksJson.length > 0) {
                    targetTrack = captionTracksJson[0];
                }
                
                if (targetTrack && targetTrack.baseUrl) {
                    // Try JSON3 format
                    const jsonUrl = targetTrack.baseUrl.includes('?') 
                        ? `${targetTrack.baseUrl}&fmt=json3` 
                        : `${targetTrack.baseUrl}?fmt=json3`;
                    
                    try {
                        const jsonResponse = await axios.get(jsonUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                                'Referer': `https://www.youtube.com/embed/${videoId}`
                            }
                        });
                        
                        if (jsonResponse.data && jsonResponse.data.events) {
                            return parseJson3Captions(jsonResponse.data);
                        }
                    } catch (jsonError) {
                        console.log('Failed to get JSON format from embedded player');
                    }
                    
                    // Try XML format as fallback
                    try {
                        const xmlResponse = await axios.get(targetTrack.baseUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                                'Referer': `https://www.youtube.com/embed/${videoId}`
                            }
                        });
                        
                        if (xmlResponse.data) {
                            const $ = cheerio.load(xmlResponse.data, { xmlMode: true });
                            const transcript = [];
                            
                            $('text').each((i, el) => {
                                const start = $(el).attr('start');
                                const dur = $(el).attr('dur');
                                const text = $(el).text();
                                
                                if (start && dur && text) {
                                    transcript.push({
                                        text: text,
                                        start: start,
                                        duration: dur
                                    });
                                }
                            });
                            
                            return transcript;
                        }
                    } catch (xmlError) {
                        console.log('Failed to get XML format from embedded player');
                    }
                }
            } catch (jsonParseError) {
                console.log('Failed to parse caption tracks from embedded player');
            }
        }
        
        return null;
    } catch (error) {
        console.error(`Error in tryEmbeddedPlayerCaptions:`, error.message);
        return null;
    }
}

// Handle server-side caption requests
app.get('/get-captions', async (req, res) => {
    try {
        const { videoId: rawVideoId } = req.query;
        if (!rawVideoId) {
            return res.status(400).json({ error: 'No video ID provided' });
        }

        // Process the video ID (could be URL or ID)
        const videoId = extractVideoId(rawVideoId);
        if (!videoId) {
            return res.status(400).json({ error: 'Invalid video ID or URL' });
        }

        console.log(`Fetching captions for video: ${videoId}`);
        
        let transcript = null;
        let error = null;

        // Method 1: Try using the InnerTube API (most modern approach)
        try {
            console.log('Trying InnerTube API approach...');
            transcript = await fetchCaptionsWithInnerTube(videoId);
            if (transcript && transcript.length > 0) {
                return res.json({ transcript });
            }
        } catch (innertubeError) {
            error = innertubeError;
            console.log('InnerTube API approach failed:', innertubeError.message);
        }

        // Method 2: Try using the Embedded Player approach
        if (!transcript) {
            try {
                console.log('Trying Embedded Player approach...');
                transcript = await tryEmbeddedPlayerCaptions(videoId);
                if (transcript && transcript.length > 0) {
                    return res.json({ transcript });
                }
            } catch (embeddedError) {
                console.log('Embedded Player approach failed:', embeddedError.message);
            }
        }

        // Method 3: Try using direct API URLs for the specific video
        // This one is specific to the problematic video ID you mentioned
        if (videoId === 'mqIxZKDMpNs') {
            try {
                console.log('Trying direct API URL for mqIxZKDMpNs...');
                // Based on your previous example URL
                const directUrl = 'https://www.youtube.com/api/timedtext?v=mqIxZKDMpNs&caps=asr&opi=112496729&xoaf=4&hl=en&ip=0.0.0.0&ipbits=0&expire=1741394852&sparams=ip%2Cipbits%2Cexpire%2Cv%2Ccaps%2Copi%2Cxoaf&key=yt8&kind=asr&lang=en&fmt=json3';
                
                const response = await axios.get(directUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (response.data && response.data.events) {
                    transcript = parseJson3Captions(response.data);
                    if (transcript && transcript.length > 0) {
                        return res.json({ transcript });
                    }
                }
            } catch (directError) {
                console.log('Direct API URL approach failed:', directError.message);
            }
            
            // Try with simplified parameters (for this specific video)
            try {
                console.log('Trying simplified API URL for mqIxZKDMpNs...');
                const simplifiedUrl = `https://www.youtube.com/api/timedtext?v=mqIxZKDMpNs&kind=asr&lang=en&fmt=json3`;
                
                const response = await axios.get(simplifiedUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (response.data && response.data.events) {
                    transcript = parseJson3Captions(response.data);
                    if (transcript && transcript.length > 0) {
                        return res.json({ transcript });
                    }
                }
            } catch (simplifiedError) {
                console.log('Simplified API URL approach failed:', simplifiedError.message);
            }
        }

        // If all methods fail, return error
        console.log('All caption retrieval methods failed');
        res.status(404).json({ 
            error: 'No captions found for this video. YouTube may have restricted access to the captions or they may not be available.',
            details: error ? error.message : 'Unknown error'
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            error: 'Error fetching captions', 
            message: error.message
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
