const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { parseString } = require('xml2js');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.static('public'));

// Serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Function to extract player response data from YouTube page
async function getVideoPlayerData(videoId) {
    try {
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
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

// Parse JSON3 format captions (the format used in auto-generated captions)
function parseJson3Captions(json3Data) {
    try {
        if (!json3Data || !json3Data.events) {
            return [];
        }
        
        const transcript = [];
        let currentText = '';
        let currentStart = 0;
        let currentDuration = 0;
        
        for (const event of json3Data.events) {
            // Skip events without segments or those that are just formatting
            if (!event.segs || event.segs.length === 0 || (event.segs.length === 1 && event.segs[0].utf8 === '\n')) {
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

// Handle server-side caption requests
app.get('/get-captions', async (req, res) => {
    try {
        const { videoId } = req.query;
        if (!videoId) {
            return res.status(400).json({ error: 'No video ID provided' });
        }

        let transcript = null;

        // Method 1: Try to get auto-generated captions in JSON3 format (new format for auto-gen)
        try {
            const playerData = await getVideoPlayerData(videoId);
            
            if (playerData && playerData.captions) {
                const captionTracks = playerData.captions.playerCaptionsTracklistRenderer?.captionTracks;
                
                if (captionTracks && captionTracks.length > 0) {
                    // First try to find English auto-generated captions
                    let captionTrack = captionTracks.find(track => 
                        track.languageCode === 'en' && 
                        track.name && 
                        track.name.simpleText && 
                        track.name.simpleText.includes('auto')
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
                        // Try to get captions in JSON3 format first (for auto-generated)
                        try {
                            const jsonUrl = `${captionTrack.baseUrl}&fmt=json3`;
                            const jsonResponse = await axios.get(jsonUrl);
                            
                            if (jsonResponse.data) {
                                transcript = parseJson3Captions(jsonResponse.data);
                                if (transcript && transcript.length > 0) {
                                    return res.json({ transcript });
                                }
                            }
                        } catch (jsonErr) {
                            console.log('Failed to get JSON3 captions, falling back to XML');
                        }
                        
                        // If JSON3 failed, try XML format
                        try {
                            const xmlResponse = await axios.get(captionTrack.baseUrl);
                            if (xmlResponse.data) {
                                parseString(xmlResponse.data, (err, result) => {
                                    if (!err && result && result.transcript && result.transcript.text) {
                                        transcript = result.transcript.text.map(item => ({
                                            text: item._,
                                            start: item.$.start,
                                            duration: item.$.dur
                                        }));
                                        
                                        if (transcript && transcript.length > 0) {
                                            return res.json({ transcript });
                                        }
                                    }
                                });
                            }
                        } catch (xmlErr) {
                            console.log('Failed to get XML captions');
                        }
                    }
                }
            }
        } catch (error) {
            console.log('Error getting captions from player data:', error);
        }

        // Method 2: Try the direct timedtext API for newer videos
        if (!transcript) {
            try {
                // Try the YouTube API format that appears in your example
                const yt_api_url = `https://www.youtube.com/api/timedtext?v=${videoId}&caps=asr&xoaf=4&hl=en&ip=0.0.0.0&ipbits=0&expire=30000&sparams=ip%2Cipbits%2Cexpire%2Cv%2Ccaps%2Cxoaf&signature=&key=yt8&kind=asr&lang=en&fmt=json3`;
                
                const apiResponse = await axios.get(yt_api_url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
                    }
                });
                
                if (apiResponse.data) {
                    transcript = parseJson3Captions(apiResponse.data);
                    if (transcript && transcript.length > 0) {
                        return res.json({ transcript });
                    }
                }
            } catch (apiErr) {
                console.log('Error fetching from YouTube API endpoint:', apiErr);
            }
        }

        // Method 3: Try the timedtext endpoint with various parameters
        const timedTextUrls = [
            // Most common formats for manual captions
            `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en`,
            `https://video.google.com/timedtext?type=track&v=${videoId}&id=0&lang=en`,
            // Auto-generated format
            `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en&kind=asr`,
            // List format to detect available tracks
            `https://video.google.com/timedtext?v=${videoId}&type=list`
        ];

        for (const url of timedTextUrls) {
            try {
                const response = await axios.get(url);
                
                if (response.data && response.data.length > 50) {
                    // If it's a list response, try to extract available tracks
                    if (url.includes('type=list')) {
                        const $ = cheerio.load(response.data, { xmlMode: true });
                        
                        // Find caption tracks
                        let captionUrl = '';
                        $('track').each((i, track) => {
                            const lang = $(track).attr('lang_code');
                            const kind = $(track).attr('kind');
                            
                            // Prioritize English auto captions
                            if (lang === 'en' && kind === 'asr') {
                                captionUrl = `https://video.google.com/timedtext?v=${videoId}&lang=en&kind=asr`;
                                return false; // Break the loop
                            }
                            
                            // Next priority: English manual captions
                            if (lang === 'en' && !kind) {
                                captionUrl = `https://video.google.com/timedtext?v=${videoId}&lang=en`;
                            }
                        });
                        
                        // If we found a caption URL, fetch it
                        if (captionUrl) {
                            const captionResponse = await axios.get(captionUrl);
                            
                            parseString(captionResponse.data, (err, result) => {
                                if (!err && result && result.transcript && result.transcript.text) {
                                    transcript = result.transcript.text.map(item => ({
                                        text: item._,
                                        start: item.$.start,
                                        duration: item.$.dur
                                    }));
                                }
                            });
                            
                            if (transcript && transcript.length > 0) {
                                return res.json({ transcript });
                            }
                        }
                    } else {
                        // Standard XML response
                        parseString(response.data, (err, result) => {
                            if (!err && result && result.transcript && result.transcript.text) {
                                transcript = result.transcript.text.map(item => ({
                                    text: item._,
                                    start: item.$.start,
                                    duration: item.$.dur
                                }));
                            }
                        });
                        
                        if (transcript && transcript.length > 0) {
                            return res.json({ transcript });
                        }
                    }
                }
            } catch (err) {
                // Continue to next URL if this one fails
                console.log(`Failed to get captions from ${url}`);
            }
        }

        // If we've tried everything and still no captions
        res.status(404).json({ error: 'No captions found for this video' });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error fetching captions' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
