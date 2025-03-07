const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());

// Serve static files from the public directory
app.use(express.static('public'));

// Serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/get-transcript', async (req, res) => {
    try {
        const { videoId } = req.query;
        
        // Try to get manual captions first
        try {
            const captionResponse = await axios.get(
                `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`
            );
            res.send(captionResponse.data);
        } catch (err) {
            // If manual captions fail, try auto-generated
            try {
                const autoCaptionResponse = await axios.get(
                    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr`
                );
                res.send(autoCaptionResponse.data);
            } catch (autoErr) {
                res.status(404).send('No captions found');
            }
        }
    } catch (error) {
        console.error('Error fetching transcript:', error);
        res.status(500).send('Error fetching transcript');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
