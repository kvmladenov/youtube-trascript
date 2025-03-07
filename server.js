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

// Parse JSON3 format captions
function parseJson3Captions(json3Data) {
    try {
        if (!json3Data || !json3Data.events) {
            return [];
        }
        
        const transcript = [];
        
        // Skip the first event which is usually just metadata
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

// Function to get video ID embedded in YouTube page
async function scrapeVideoPage(videoId) {
    try {
        // First, get the main page to extract any session tokens or cookies that might be needed
        const pageResponse = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.youtube.com/'
            }
        });
        
        // Look for the captions URL or data in the page
        const html = pageResponse.data;
        
        // Try to find the player response data
        const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?});/;
        const match = html.match(playerResponseRegex);
        
        if (match && match[1]) {
            try {
                const playerResponse = JSON.parse(match[1]);
                
                // Look for captions data
                if (playerResponse.captions && 
                    playerResponse.captions.playerCaptionsTracklistRenderer && 
                    playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks) {
                    
                    const captionTracks = playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
                    
                    // First look for auto-generated English
                    let captionTrack = captionTracks.find(track => 
                        track.languageCode === 'en' && 
                        track.name && 
                        track.name.simpleText && 
                        track.name.simpleText.toLowerCase().includes('auto')
                    );
                    
                    // If not found, try any English captions
                    if (!captionTrack) {
                        captionTrack = captionTracks.find(track => track.languageCode === 'en');
                    }
                    
                    // If still not found, use the first available track
                    if (!captionTrack && captionTracks.length > 0) {
                        captionTrack = captionTracks[0];
                    }
                    
                    if (captionTrack && captionTrack.baseUrl) {
                        // Try to append &fmt=json3 to get JSON format
                        const jsonUrl = captionTrack.baseUrl.includes('?') 
                            ? `${captionTrack.baseUrl}&fmt=json3` 
                            : `${captionTrack.baseUrl}?fmt=json3`;
                            
                        console.log('Found caption URL:', jsonUrl);
                        return {
                            baseUrl: captionTrack.baseUrl,
                            jsonUrl: jsonUrl,
                            vssId: captionTrack.vssId,
                            name: captionTrack.name ? captionTrack.name.simpleText : 'Unknown',
                            languageCode: captionTrack.languageCode
                        };
                    }
                }
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

// Handle server-side caption requests
app.get('/get-captions', async (req, res) => {
    try {
        const { videoId } = req.query;
        if (!videoId) {
            return res.status(400).json({ error: 'No video ID provided' });
        }

        // Strategy 1: Try direct access to JSON3 format first (this often works for auto-generated captions)
        console.log(`Fetching captions for video: ${videoId}`);
        
        // Get the video page to extract caption info
        const captionInfo = await scrapeVideoPage(videoId);
        
        if (captionInfo) {
            console.log(`Found caption info: ${captionInfo.name} (${captionInfo.languageCode})`);
            
            // First try to get the JSON3 format
            try {
                const jsonResponse = await axios.get(captionInfo.jsonUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (jsonResponse.data && jsonResponse.data.events) {
                    const transcript = parseJson3Captions(jsonResponse.data);
                    if (transcript && transcript.length > 0) {
                        return res.json({ transcript });
                    }
                }
            } catch (jsonError) {
                console.error('Failed to get JSON3 captions:', jsonError.message);
            }
            
            // If JSON3 failed, try the regular format
            try {
                const baseResponse = await axios.get(captionInfo.baseUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                        'Referer': `https://www.youtube.com/watch?v=${videoId}`
                    }
                });
                
                if (baseResponse.data) {
                    // Try to parse XML format if that's what we got
                    const $ = cheerio.load(baseResponse.data, { xmlMode: true });
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
            } catch (baseError) {
                console.error('Failed to get base format captions:', baseError.message);
            }
        }
        
        // Strategy 2: Try direct API endpoint (similar to what you found)
        try {
            // We're attempting to access the API directly without the exact parameters
            // This may not work, but it's worth trying
            const apiUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&caps=asr&xoaf=4&hl=en&fmt=json3&kind=asr&lang=en`;
            
            const apiResponse = await axios.get(apiUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                    'Referer': `https://www.youtube.com/watch?v=${videoId}`
                }
            });
            
            if (apiResponse.data && apiResponse.data.events) {
                const transcript = parseJson3Captions(apiResponse.data);
                if (transcript && transcript.length > 0) {
                    return res.json({ transcript });
                }
            }
        } catch (apiError) {
            console.error('Failed to get captions from API endpoint:', apiError.message);
        }
        
        // Strategy 3: Try some alternative approaches for auto-generated captions
        const alternativeUrls = [
            // Try variations of the format
            `https://www.youtube.com/api/timedtext?v=${videoId}&caps=asr&xoaf=4&hl=en&fmt=json3`,
            `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`,
            `https://video.google.com/timedtext?lang=en&v=${videoId}&fmt=json3`,
            `https://video.google.com/timedtext?lang=en&v=${videoId}&kind=asr&fmt=json3`
        ];
        
        for (const url of alternativeUrls) {
            try {
                const response = await axios.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
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

        // If all strategies fail
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
