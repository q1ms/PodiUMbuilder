const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.static(__dirname));

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