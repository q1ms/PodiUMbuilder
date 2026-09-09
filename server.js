const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static(__dirname));

// ===== MONGODB =====
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const client = new MongoClient(MONGODB_URI, {
    tls: true,
    tlsAllowInvalidCertificates: true,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
});
let db;
let dbConnected = false;

async function connectDB() {
    try {
        await client.connect();
        db = client.db('podium');
        dbConnected = true;
        console.log('✅ Connected to MongoDB');
    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
        dbConnected = false;
        // Retry after 5 seconds
        setTimeout(connectDB, 5000);
    }
}
connectDB();

// ===== UNCAUGHT EXCEPTION HANDLER =====
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    // Keep the server running
});

// ===== Helper to check DB connection =====
function ensureDB(req, res, next) {
    if (!dbConnected) {
        return res.status(503).json({ error: 'Database is connecting, please try again in a moment' });
    }
    next();
}

// ===== AUTH MIDDLEWARE =====
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ===== LOGIN =====
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Wrong password' });
    }
});

// ===== UPLOAD =====
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.post('/upload', authenticate, upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ success: true, path: url });
});

// ===== SITES =====
app.get('/api/sites', authenticate, ensureDB, async (req, res) => {
    try {
        const sites = await db.collection('sites').find({}).toArray();
        res.json(sites);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sites', authenticate, ensureDB, async (req, res) => {
    try {
        const newSite = req.body;
        newSite.createdAt = new Date();
        newSite.updatedAt = new Date();
        const result = await db.collection('sites').insertOne(newSite);
        res.json({ ...newSite, _id: result.insertedId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/sites/:id', authenticate, ensureDB, async (req, res) => {
    try {
        const { id } = req.params;
        const update = req.body;
        delete update._id;
        update.updatedAt = new Date();
        const result = await db.collection('sites').updateOne(
            { _id: new ObjectId(id) },
            { $set: update }
        );
        if (result.matchedCount === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sites/:id', authenticate, ensureDB, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.collection('sites').deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== CONFIG (public read, protected write) =====
app.get('/api/config', async (req, res) => {
    try {
        if (!dbConnected) return res.status(503).json({ error: 'Database connecting' });
        const config = await db.collection('config').findOne({});
        res.json(config || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/config', authenticate, ensureDB, async (req, res) => {
    try {
        await db.collection('config').deleteMany({});
        await db.collection('config').insertOne(req.body);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== MEDIA =====
app.get('/api/media', authenticate, ensureDB, async (req, res) => {
    try {
        const media = await db.collection('media').find({}).toArray();
        res.json(media);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/media', authenticate, ensureDB, async (req, res) => {
    try {
        const item = req.body;
        item.createdAt = new Date();
        const result = await db.collection('media').insertOne(item);
        res.json({ ...item, _id: result.insertedId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/media/:id', authenticate, ensureDB, async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('media').deleteOne({ _id: new ObjectId(id) });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== SERVE STATIC FILES =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});