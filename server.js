const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/get-transcript', async (req, res) => {
    try {
        const { videoId } = req.query;
        
        // Try to get manual captions first
        const response = await axios.get(
            `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en`
        );
        
        res.send(response.data);
    } catch (error) {
        // Try auto-generated captions if manual ones fail
        try {
            const response = await axios.get(
                `https://video.google.com/timedtext?type=track&v=${videoId}&lang=en&kind=asr`
            );
            res.send(response.data);
        } catch (err) {
            res.status(404).send('No captions found');
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
