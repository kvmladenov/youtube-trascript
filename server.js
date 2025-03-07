const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { parseString } = require('xml2js');

const app = express();
app.use(cors());
app.use(express.static('public'));

// Serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle server-side caption requests
app.get('/get-captions', async (req, res) => {
    try {
        const { videoId } = req.query;
        if (!videoId) {
            return res.status(400).json({ error: 'No video ID provided' });
        }

        // First try manual captions
        try {
            const response = await axios.get(
                `https://video.google.com/timedtext?type=track&v=${videoId}&id=0&lang=en`
            );
            
            // Parse XML to JSON
            parseString(response.data, (err, result) => {
                if (err) {
                    throw new Error('Error parsing XML');
                }
                
                // If transcript exists and has text elements
                if (result && result.transcript && result.transcript.text) {
                    const transcript = result.transcript.text.map(item => ({
                        text: item._,
                        start: item.$.start,
                        duration: item.$.dur
                    }));
                    
                    res.json({ transcript });
                } else {
                    throw new Error('No transcript found');
                }
            });
        } catch (error) {
            // If manual captions fail, try auto-generated
            try {
                const autoResponse = await axios.get(
                    `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en&kind=asr`
                );
                
                // Parse XML to JSON
                parseString(autoResponse.data, (err, result) => {
                    if (err) {
                        throw new Error('Error parsing XML');
                    }
                    
                    // If transcript exists and has text elements
                    if (result && result.transcript && result.transcript.text) {
                        const transcript = result.transcript.text.map(item => ({
                            text: item._,
                            start: item.$.start,
                            duration: item.$.dur
                        }));
                        
                        res.json({ transcript });
                    } else {
                        throw new Error('No auto transcript found');
                    }
                });
            } catch (err) {
                // Try one more fallback - English captions with no specific kind
                try {
                    const fallbackResponse = await axios.get(
                        `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en`
                    );
                    
                    // Parse XML to JSON
                    parseString(fallbackResponse.data, (err, result) => {
                        if (err) {
                            throw new Error('Error parsing XML');
                        }
                        
                        // If transcript exists and has text elements
                        if (result && result.transcript && result.transcript.text) {
                            const transcript = result.transcript.text.map(item => ({
                                text: item._,
                                start: item.$.start,
                                duration: item.$.dur
                            }));
                            
                            res.json({ transcript });
                        } else {
                            res.status(404).json({ error: 'No captions found for this video' });
                        }
                    });
                } catch (finalErr) {
                    res.status(404).json({ error: 'No captions found for this video' });
                }
            }
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error fetching captions' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
