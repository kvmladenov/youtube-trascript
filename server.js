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

// Get video metadata to find auto captions
async function getVideoMetadata(videoId) {
    try {
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`);
        const html = response.data;
        
        // Search for ytInitialPlayerResponse
        const playerResponseRegex = /ytInitialPlayerResponse\s*=\s*({.+?});/;
        const match = html.match(playerResponseRegex);
        
        if (match && match[1]) {
            const playerResponse = JSON.parse(match[1]);
            return playerResponse;
        }
    } catch (error) {
        console.error('Error getting video metadata:', error);
    }
    
    return null;
}

// Handle server-side caption requests
app.get('/get-captions', async (req, res) => {
    try {
        const { videoId } = req.query;
        if (!videoId) {
            return res.status(400).json({ error: 'No video ID provided' });
        }

        // Try methods in order: manual captions, auto-gen captions, timedtext API, metadata extraction
        let transcript = null;

        // 1. First try manual captions (direct API call)
        try {
            const response = await axios.get(
                `https://video.google.com/timedtext?type=track&v=${videoId}&id=0&lang=en`
            );
            
            // If response has actual content
            if (response.data && response.data.length > 50) {
                // Parse XML to JSON
                parseString(response.data, (err, result) => {
                    if (!err && result && result.transcript && result.transcript.text) {
                        transcript = result.transcript.text.map(item => ({
                            text: item._,
                            start: item.$.start,
                            duration: item.$.dur
                        }));
                    }
                });
            }
        } catch (error) {
            console.log('Manual captions not found, trying alternatives...');
        }

        // 2. If manual captions fail, try auto-generated captions
        if (!transcript) {
            try {
                const autoResponse = await axios.get(
                    `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en&kind=asr`
                );
                
                // If response has actual content
                if (autoResponse.data && autoResponse.data.length > 50) {
                    // Parse XML to JSON
                    parseString(autoResponse.data, (err, result) => {
                        if (!err && result && result.transcript && result.transcript.text) {
                            transcript = result.transcript.text.map(item => ({
                                text: item._,
                                start: item.$.start,
                                duration: item.$.dur
                            }));
                        }
                    });
                }
            } catch (err) {
                console.log('Auto captions not found directly, trying more alternatives...');
            }
        }

        // 3. Try generic English captions
        if (!transcript) {
            try {
                const fallbackResponse = await axios.get(
                    `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en`
                );
                
                // If response has actual content
                if (fallbackResponse.data && fallbackResponse.data.length > 50) {
                    // Parse XML to JSON
                    parseString(fallbackResponse.data, (err, result) => {
                        if (!err && result && result.transcript && result.transcript.text) {
                            transcript = result.transcript.text.map(item => ({
                                text: item._,
                                start: item.$.start,
                                duration: item.$.dur
                            }));
                        }
                    });
                }
            } catch (finalErr) {
                console.log('Generic EN captions not found, trying metadata approach...');
            }
        }

        // 4. Try getting captions from video metadata
        if (!transcript) {
            try {
                const metadata = await getVideoMetadata(videoId);
                
                if (metadata && metadata.captions) {
                    const captionTracks = metadata.captions.playerCaptionsTracklistRenderer?.captionTracks;
                    
                    if (captionTracks && captionTracks.length > 0) {
                        // First try to find English captions
                        let captionTrack = captionTracks.find(track => 
                            track.languageCode === 'en' && !track.name.simpleText.includes('auto')
                        );
                        
                        // If no manual English captions, try auto-generated English
                        if (!captionTrack) {
                            captionTrack = captionTracks.find(track => 
                                track.languageCode === 'en' && track.name.simpleText.includes('auto')
                            );
                        }
                        
                        // If still no English, take the first available track
                        if (!captionTrack && captionTracks.length > 0) {
                            captionTrack = captionTracks[0];
                        }
                        
                        if (captionTrack && captionTrack.baseUrl) {
                            const captionResponse = await axios.get(captionTrack.baseUrl);
                            if (captionResponse.data) {
                                parseString(captionResponse.data, (err, result) => {
                                    if (!err && result && result.transcript && result.transcript.text) {
                                        transcript = result.transcript.text.map(item => ({
                                            text: item._,
                                            start: item.$.start,
                                            duration: item.$.dur
                                        }));
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (metadataErr) {
                console.error('Error fetching captions via metadata:', metadataErr);
            }
        }

        // 5. If we have a transcript, return it
        if (transcript && transcript.length > 0) {
            return res.json({ transcript });
        }

        // 6. If all methods fail, try YouTube's caption list API
        try {
            const listResponse = await axios.get(
                `https://video.google.com/timedtext?v=${videoId}&type=list`
            );
            
            if (listResponse.data) {
                const $ = cheerio.load(listResponse.data, { xmlMode: true });
                
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
                            
                            return res.json({ transcript });
                        }
                    });
                }
            }
        } catch (listErr) {
            console.error('Error fetching caption list:', listErr);
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
