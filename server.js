const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

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
const client = new MongoClient(MONGODB_URI);
let db;

async function connectDB() {
    await client.connect();
    db = client.db('podium');
    console.log('✅ Connected to MongoDB');
}
connectDB().catch(console.error);

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

// ===== UPLOAD (temporary local) =====
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
app.get('/api/sites', authenticate, async (req, res) => {
    const sites = await db.collection('sites').find({}).toArray();
    res.json(sites);
});

app.post('/api/sites', authenticate, async (req, res) => {
    const newSite = req.body;
    newSite.createdAt = new Date();
    newSite.updatedAt = new Date();
    const result = await db.collection('sites').insertOne(newSite);
    res.json({ ...newSite, _id: result.insertedId });
});

app.put('/api/sites/:id', authenticate, async (req, res) => {
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
});

app.delete('/api/sites/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    const result = await db.collection('sites').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
});

// ===== CONFIG (public read, protected write) =====
app.get('/api/config', async (req, res) => {
    const config = await db.collection('config').findOne({});
    res.json(config || {});
});

app.post('/api/config', authenticate, async (req, res) => {
    await db.collection('config').deleteMany({});
    await db.collection('config').insertOne(req.body);
    res.json({ success: true });
});

// ===== MEDIA =====
app.get('/api/media', authenticate, async (req, res) => {
    const media = await db.collection('media').find({}).toArray();
    res.json(media);
});

app.post('/api/media', authenticate, async (req, res) => {
    const item = req.body;
    item.createdAt = new Date();
    const result = await db.collection('media').insertOne(item);
    res.json({ ...item, _id: result.insertedId });
});

app.delete('/api/media/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    await db.collection('media').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
});

// ===== SERVE STATIC FILES =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});