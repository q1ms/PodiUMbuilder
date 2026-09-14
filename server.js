require('dotenv').config();
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const winston = require('winston');
const Sentry = require('@sentry/node');

// ================================================================
// CONFIG
// ================================================================
const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SENTRY_DSN = process.env.SENTRY_DSN; // optional
const NODE_ENV = process.env.NODE_ENV || 'development';

// ================================================================
// LOGGER
// ================================================================
const logger = winston.createLogger({
    level: NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
    ],
});

// ================================================================
// SENTRY (error tracking)
// ================================================================
if (SENTRY_DSN) {
    Sentry.init({ dsn: SENTRY_DSN, environment: NODE_ENV });
    logger.info('✅ Sentry initialized');
}

// ================================================================
// SECURITY MIDDLEWARE
// ================================================================
app.use(helmet({
    contentSecurityPolicy: false, // we use Tailwind + CDN scripts
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Rate limiters
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 10, // 10 login attempts per 15 min
    message: { error: 'Too many login attempts. Try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 min
    max: 120, // 120 req/min
    message: { error: 'Too many requests. Slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// ================================================================
// AUTH MIDDLEWARE
// ================================================================
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ================================================================
// LOGIN (with bcrypt-hashed password)
// ================================================================
// Pre-hash the admin password once on startup
let ADMIN_PASSWORD_HASH = null;
(async () => {
    ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD, 10);
    logger.info('✅ Admin password hashed');
})();

app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password required' });

        // Wait for hash to be ready
        if (!ADMIN_PASSWORD_HASH) {
            ADMIN_PASSWORD_HASH = await bcrypt.hash(ADMIN_PASSWORD, 10);
        }

        const match = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
        if (!match) {
            logger.warn(`Failed login attempt from ${req.ip}`);
            return res.status(401).json({ error: 'Wrong password' });
        }

        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
        logger.info(`Successful login from ${req.ip}`);
        res.json({ success: true, token });
    } catch (e) {
        logger.error('Login error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/verify', authenticate, (req, res) => {
    res.json({ valid: true });
});

// ================================================================
// CLOUDINARY SIGNED UPLOAD HELPER
// ================================================================
async function uploadToCloudinary(content, publicId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = `invalidate=true&overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
    const signature = crypto
        .createHash('sha1')
        .update(paramsToSign + process.env.CLOUDINARY_API_SECRET)
        .digest('hex');

    const formData = new FormData();
    const blob = new Blob([JSON.stringify(content)], { type: 'application/json' });
    formData.append('file', blob, `${publicId.split('/').pop()}.json`);
    formData.append('api_key', process.env.CLOUDINARY_API_KEY);
    formData.append('timestamp', timestamp);
    formData.append('public_id', publicId);
    formData.append('signature', signature);
    formData.append('overwrite', 'true');
    formData.append('invalidate', 'true');

    const url = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload`;
    const resp = await fetch(url, { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Upload failed');
    return data.secure_url;
}

// ================================================================
// SAVE SITE
// ================================================================
app.post('/api/save-site', authenticate, async (req, res, next) => {
    try {
        const { siteId, siteData } = req.body;
        if (!siteId || !siteData) return res.status(400).json({ error: 'Missing siteId or siteData' });

        // Validate siteId (prevent path traversal)
        if (!/^site-\d+$/.test(siteId)) return res.status(400).json({ error: 'Invalid siteId format' });

        // Validate data is an object
        if (typeof siteData !== 'object' || Array.isArray(siteData)) {
            return res.status(400).json({ error: 'siteData must be an object' });
        }

        const url = await uploadToCloudinary(siteData, `podium-sites/${siteId}`);
        logger.info(`Saved site: ${siteId}`);
        res.json({ success: true, url });
    } catch (err) {
        next(err);
    }
});

// ================================================================
// LOAD SITE
// ================================================================
app.get('/api/load-site/:siteId', async (req, res, next) => {
    try {
        const { siteId } = req.params;
        if (!/^site-\d+$/.test(siteId)) return res.status(400).json({ error: 'Invalid siteId' });

        const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/podium-sites/${siteId}.json?t=${Date.now()}`;
        const resp = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
        if (!resp.ok) return res.status(404).json({ error: 'Site not found' });

        const data = await resp.json();
        res.setHeader('Cache-Control', 'no-store');
        res.json(data);
    } catch (err) {
        next(err);
    }
});

// ================================================================
// SAVE MANIFEST
// ================================================================
app.post('/api/save-manifest', authenticate, async (req, res, next) => {
    try {
        const { sites } = req.body;
        if (!Array.isArray(sites)) return res.status(400).json({ error: 'sites must be array' });

        const url = await uploadToCloudinary(
            { sites, updatedAt: new Date().toISOString() },
            'podium-sites/manifest'
        );
        logger.info(`Saved manifest (${sites.length} sites)`);
        res.json({ success: true, url });
    } catch (err) {
        next(err);
    }
});

// ================================================================
// LOAD MANIFEST
// ================================================================
app.get('/api/load-manifest', async (req, res, next) => {
    try {
        const url = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/podium-sites/manifest.json?t=${Date.now()}`;
        const resp = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
        if (!resp.ok) return res.json({ sites: [] });

        const data = await resp.json();
        res.setHeader('Cache-Control', 'no-store');
        res.json(data);
    } catch (err) {
        next(err);
    }
});

// ================================================================
// HEALTH CHECK (for UptimeRobot)
// ================================================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ================================================================
// STATIC FILES
// ================================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ================================================================
// GLOBAL ERROR HANDLER (MUST be last)
// ================================================================
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    if (SENTRY_DSN) Sentry.captureException(err);

    // Don't leak internals in production
    const message = NODE_ENV === 'production' ? 'Server error' : err.message;
    res.status(err.status || 500).json({ error: message });
});

// ================================================================
// SERVER START
// ================================================================
app.listen(PORT, () => {
    logger.info(`✅ Server running on port ${PORT}`);
    logger.info(`📝 Environment: ${NODE_ENV}`);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    if (SENTRY_DSN) Sentry.captureException(err);
});

process.on('unhandledRejection', (err) => {
    logger.error('Unhandled Rejection:', err);
    if (SENTRY_DSN) Sentry.captureException(err);
});