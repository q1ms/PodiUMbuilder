const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.static(__dirname));

// ===== SAVE SITE (signed Cloudinary upload with overwrite) =====
app.post('/api/save-site', async (req, res) => {
    try {
        const { siteId, siteData } = req.body;
        if (!siteId || !siteData) return res.status(400).json({ error: 'Missing siteId or siteData' });

        const timestamp = Math.floor(Date.now() / 1000);
        const publicId = `podium-sites/${siteId}`;

        // Generate Cloudinary signature
        const paramsToSign = `public_id=${publicId}&timestamp=${timestamp}&overwrite=true`;
        const signature = crypto
            .createHash('sha1')
            .update(paramsToSign + process.env.CLOUDINARY_API_SECRET)
            .digest('hex');

        // Prepare form data
        const formData = new FormData();
        const blob = new Blob([JSON.stringify(siteData)], { type: 'application/json' });
        formData.append('file', blob, `${siteId}.json`);
        formData.append('api_key', process.env.CLOUDINARY_API_KEY);
        formData.append('timestamp', timestamp);
        formData.append('public_id', publicId);
        formData.append('signature', signature);
        formData.append('overwrite', 'true');

        // Upload to Cloudinary (raw type for JSON)
        const url = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload`;
        const resp = await fetch(url, { method: 'POST', body: formData });
        const data = await resp.json();

        if (!resp.ok) {
            console.error('Cloudinary error:', data);
            return res.status(500).json({ error: data.error?.message || 'Upload failed' });
        }

        res.json({ success: true, url: data.secure_url, publicId });
    } catch (err) {
        console.error('Save site error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ===== LOAD SITE =====
app.get('/api/load-site/:siteId', async (req, res) => {
    try {
        const { siteId } = req.params;
        const publicId = `podium-sites/${siteId}`;
        // Public URL format for raw uploads
        const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/${publicId}.json`;
        const resp = await fetch(url + '?t=' + Date.now());
        if (!resp.ok) return res.status(404).json({ error: 'Site not found' });
        const data = await resp.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Login
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Wrong password' });
    }
});

// Verify token
app.get('/api/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    try {
        jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        res.json({ valid: true });
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});