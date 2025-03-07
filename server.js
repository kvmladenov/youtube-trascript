const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.static('public'));

// Serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Parse JSON3 format captions as documented in the 2025 guide
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

// Function to extract video ID from YouTube URL
function extractVideoId(url) {
    // Handle youtu.be URLs
    let youtubeShortRegex = /youtu\.be\/([a-zA-Z0-9_-]{11})/;
    let match = url.match(youtubeShortRegex);
    if (match) {
        return match[1];
    }
    
    // Handle youtube.com URLs with v= parameter
    let youtubeRegex = /[?&]v=([a-zA-Z0-9_-]{11})/;
    match = url.match(youtubeRegex);
    if (match) {
        return match[1];
    }
    
    // Handle youtube.com/embed URLs
    let embedRegex = /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/;
    match = url.match(embedRegex);
    if (match) {
        return match[1];
    }

    // If the URL itself is just the ID
    if (url.match(/^[a-zA-Z0-9_-]{11}$/)) {
        return url;
    }
    
    return null;
}

// Function to extract player response data from YouTube page to get captions info
async function getVideoPlayerData(videoId) {
    try {
        // Rotate user agents to avoid detection as mentioned in the guide
        const userAgents = [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
        ];
        
        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': randomUserAgent,
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.youtube.com/'
            }
        });
        
        const html = response.data;
        
        // Extract ytInitialPlayerResponse
        const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?});/;
        const match = html.match(playerResponseRegex);
        
        if (match && match[1]) {
            try {
                return JSON.parse(match[1]);
            } catch (e) {
                console.error('Error parsing player response:', e);
            }
        }
        
        return null;
    } catch (error) {
        console.error('Error fetching video page:', error);
        return null;
    }
}

// Implement exponential backoff for failed requests as recommended in the guide
async function fetchWithRetry(url, options, maxRetries = 3) {
    let retries = 0;
    
    while (retries < maxRetries) {
        try {
            return await axios.get(url, options);
        } catch (error) {
            retries++;
            if (retries === maxRetries) {
                throw error;
            }
            
            // Exponential backoff
            const delay = Math.pow(2, retries) * 1000;
            console.log(`Retry ${retries}/${maxRetries} after ${delay}ms for URL: ${url}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
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
            return res.status(400).json({ error: 'Invalid video ID' });
        }

        console.log(`Fetching captions for video: ${videoId}`);
        
        // Cache key to store transcripts locally
        const cacheKey = `transcript-${videoId}`;
        
        // Try Method 1: Direct JSON3 API approach (as described in the guide)
        try {
            // Based on the guide's recommended approach:
            // https://www.youtube.com/watch?v=VIDEO_ID
            // → /api/timedtext?lang=en&v=VIDEO_ID&fmt=json3
            const json3Url = `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}&fmt=json3`;
            
            console.log(`Trying direct JSON3 API: ${json3Url}`);
            
            const response = await fetchWithRetry(json3Url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                    'Referer': `https://www.youtube.com/watch?v=${videoId}`
                }
            });
            
            if (response.data && response.data.events) {
                const transcript = parseJson3Captions(response.data);
                if (transcript && transcript.length > 0) {
                    return res.json({ transcript });
                }
            }
        } catch (error) {
            console.log('Direct JSON3 API failed:', error.message);
        }

        // Method 2: Try to get auto-generated captions through video metadata
        try {
            console.log('Trying to extract captions from player data');
            
            const playerData = await getVideoPlayerData(videoId);
            
            if (playerData && playerData.captions) {
                const captionTracks = playerData.captions.playerCaptionsTracklistRenderer?.captionTracks;
                
                if (captionTracks && captionTracks.length > 0) {
                    // First try to find English auto-generated captions
                    let captionTrack = captionTracks.find(track => 
                        track.languageCode === 'en' && 
                        track.name && 
                        track.name.simpleText && 
                        track.name.simpleText.toLowerCase().includes('auto')
                    );
                    
                    // If no auto-generated English, try any English
                    if (!captionTrack) {
                        captionTrack = captionTracks.find(track => track.languageCode === 'en');
                    }
                    
                    // If still nothing, take the first available track
                    if (!captionTrack && captionTracks.length > 0) {
                        captionTrack = captionTracks[0];
                    }
                    
                    if (captionTrack && captionTrack.baseUrl) {
                        // Try to get captions in JSON3 format
                        try {
                            const jsonUrl = `${captionTrack.baseUrl}&fmt=json3`;
                            console.log(`Trying caption track URL: ${jsonUrl}`);
                            
                            const jsonResponse = await fetchWithRetry(jsonUrl, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                                    'Referer': `https://www.youtube.com/watch?v=${videoId}`
                                }
                            });
                            
                            if (jsonResponse.data && jsonResponse.data.events) {
                                const transcript = parseJson3Captions(jsonResponse.data);
                                if (transcript && transcript.length > 0) {
                                    return res.json({ transcript });
                                }
                            }
                        } catch (jsonErr) {
                            console.log('Failed to get JSON3 captions from track URL, falling back to XML');
                        }
                        
                        // If JSON3 failed, try XML format
                        try {
                            const xmlResponse = await fetchWithRetry(captionTrack.baseUrl, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                                    'Referer': `https://www.youtube.com/watch?v=${videoId}`
                                }
                            });
                            
                            if (xmlResponse.data) {
                                // Parse XML format
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
                                
                                if (transcript.length > 0) {
                                    return res.json({ transcript });
                                }
                            }
                        } catch (xmlErr) {
                            console.log('Failed to get XML captions:', xmlErr.message);
                        }
                    }
                }
            }
        } catch (error) {
            console.log('Error getting captions from player data:', error);
        }

        // Method 3: Try alternative JSON3 API endpoints with various parameters
        const alternativeUrls = [
            // Try with ASR parameter (for auto-generated captions)
            `https://www.youtube.com/api/timedtext?v=${videoId}&caps=asr&xoaf=4&hl=en&fmt=json3&kind=asr&lang=en`,
            // Try with different parameter combinations
            `https://www.youtube.com/api/timedtext?v=${videoId}&xoaf=4&hl=en&fmt=json3&lang=en`,
            `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3&tlang=en`,
            // Try with different domains
            `https://video.google.com/timedtext?lang=en&v=${videoId}&fmt=json3`,
            `https://video.google.com/timedtext?lang=en&v=${videoId}&kind=asr&fmt=json3`
        ];
        
        for (const url of alternativeUrls) {
            try {
                console.log(`Trying alternative URL: ${url}`);
                
                const response = await fetchWithRetry(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (response.data && response.data.events) {
                    const transcript = parseJson3Captions(response.data);
                    if (transcript && transcript.length > 0) {
                        return res.json({ transcript });
                    }
                }
            } catch (altError) {
                console.log(`Failed to get captions from ${url}`);
            }
        }

        // If all methods fail
        console.log('All caption retrieval strategies failed');
        res.status(404).json({ 
            error: 'No captions found for this video. YouTube may have restricted access to the captions or they may not be available.',
            videoId: videoId
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
