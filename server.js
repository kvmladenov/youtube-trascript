const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
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
        
        // Try to get manual captions first
        try {
            const response = await axios.get(
                `https://video.google.com/timedtext?type=track&v=${videoId}&id=0&lang=en`
            );
            res.send(response.data);
        } catch (error) {
            // If manual captions fail, try auto-generated
            try {
                const autoResponse = await axios.get(
                    `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en&kind=asr`
                );
                res.send(autoResponse.data);
            } catch (err) {
                res.status(404).send('No captions found');
            }
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Error fetching captions');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
