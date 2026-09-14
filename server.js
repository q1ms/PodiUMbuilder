require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const winston = require('winston');
const Sentry = require('@sentry/node');
const { createClient } = require('@supabase/supabase-js');

// ================================================================
// CONFIG
// ================================================================
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SENTRY_DSN = process.env.SENTRY_DSN;

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
            format: winston.format.combine(winston.format.colorize(), winston.format.simple())
        }),
    ],
});

// ================================================================
// SENTRY
// ================================================================
if (SENTRY_DSN) {
    Sentry.init({ dsn: SENTRY_DSN, environment: NODE_ENV });
    logger.info('✅ Sentry initialized');
}

// ================================================================
// SUPABASE CLIENTS
// ================================================================
// Public client (uses anon key, respects RLS)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Admin client (uses service key, bypasses RLS — use carefully)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
);

// ================================================================
// SECURITY MIDDLEWARE
// ================================================================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: true, credentials: true }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Rate limiters
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts. Try again later.' },
    standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many requests. Slow down.' },
    standardHeaders: true, legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// ================================================================
// AUTH MIDDLEWARE — verifies Supabase JWT
// ================================================================
async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) return res.status(401).json({ error: 'Invalid token' });
        req.user = user;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ================================================================
// AUTH ROUTES
// ================================================================

// Sign up (create account)
app.post('/api/signup', loginLimiter, async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

        // Check if user already exists
        const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
        const existing = existingUsers?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

        if (existing) {
            if (existing.email_confirmed_at) {
                return res.status(400).json({
                    error: 'This email is already registered. Please log in instead.'
                });
            } else {
                // Existing but unconfirmed — resend confirmation
                const { error: resendError } = await supabase.auth.resend({
                    type: 'signup',
                    email,
                    options: {
                        emailRedirectTo: `${req.protocol}://${req.get('host')}/auth-callback.html`,
                    },
                });
                if (resendError) return res.status(400).json({ error: resendError.message });
                return res.json({
                    success: true,
                    message: 'Confirmation email re-sent. Please check your inbox.',
                    session: null,
                });
            }
        }

        // New user — sign up with proper redirect
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                emailRedirectTo: `${req.protocol}://${req.get('host')}/auth-callback.html`,
            },
        });
        if (error) return res.status(400).json({ error: error.message });

        logger.info(`New user signed up: ${email}`);
        res.json({ success: true, user: data.user, session: data.session });
    } catch (err) { next(err); }
});

// Login
app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            logger.warn(`Failed login: ${email} from ${req.ip}`);
            return res.status(401).json({ error: error.message });
        }

        logger.info(`Login: ${email}`);
        res.json({ success: true, session: data.session, user: data.user });
    } catch (err) { next(err); }
});

// Verify token
app.get('/api/verify', authenticate, (req, res) => {
    res.json({ valid: true, user: { id: req.user.id, email: req.user.email } });
});

// Get current user
app.get('/api/me', authenticate, (req, res) => {
    res.json({ id: req.user.id, email: req.user.email });
});

// ================================================================
// SITES CRUD
// ================================================================

// List all sites for current user
app.get('/api/sites', authenticate, async (req, res, next) => {
    try {
        const { data, error } = await supabase
            .from('sites')
            .select('id, name, created_at, updated_at, data->logoUrl, data->bgColor')
            .eq('user_id', req.user.id)
            .order('updated_at', { ascending: false });

        if (error) throw error;
        res.json(data || []);
    } catch (err) { next(err); }
});

// Get one site (full data)
app.get('/api/sites/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase
            .from('sites')
            .select('*')
            .eq('id', id)
            .eq('user_id', req.user.id)
            .single();

        if (error || !data) return res.status(404).json({ error: 'Site not found' });
        res.json(data);
    } catch (err) { next(err); }
});

// Create new site
app.post('/api/sites', authenticate, async (req, res, next) => {
    try {
        const { name = 'Untitled Site', data = {} } = req.body;
        const { data: site, error } = await supabase
            .from('sites')
            .insert({
                user_id: req.user.id,
                name,
                data: {
                    components: [],
                    tabs: [{ id: 'main', label: 'Main' }],
                    activeTab: 'main',
                    logoUrl: '',
                    bgColor: '#ffffff',
                    topBarColor: '#ffffff',
                    media: [],
                    ...data,
                },
            })
            .select()
            .single();

        if (error) throw error;
        logger.info(`Created site: ${site.id} for ${req.user.email}`);
        res.json(site);
    } catch (err) { next(err); }
});

// Update site
app.put('/api/sites/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, data } = req.body;

        console.log('📝 PUT /api/sites/' + id, 'user:', req.user.id);

        const update = {};
        if (name !== undefined) update.name = name;
        if (data !== undefined) update.data = data;

        const { data: site, error } = await supabase
            .from('sites')
            .update(update)
            .eq('id', id)
            .eq('user_id', req.user.id)
            .select()
            .single();

        if (error) {
            console.error('Supabase update error:', error);
            return res.status(500).json({ error: error.message });
        }
        if (!site) {
            return res.status(404).json({ error: 'Site not found' });
        }

        res.json(site);
    } catch (err) {
        console.error('PUT site exception:', err);
        res.status(500).json({ error: err.message });
    }
});

// Delete site
app.delete('/api/sites/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('sites')
            .delete()
            .eq('id', id)
            .eq('user_id', req.user.id);

        if (error) throw error;
        logger.info(`Deleted site: ${id}`);
        res.json({ success: true });
    } catch (err) { next(err); }
});

// ================================================================
// CLOUDINARY SIGNED UPLOAD (for site audio)
// ================================================================
async function uploadToCloudinary(content, publicId, resourceType = 'raw') {
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = `invalidate=true&overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
    const signature = crypto
        .createHash('sha1')
        .update(paramsToSign + process.env.CLOUDINARY_API_SECRET)
        .digest('hex');

    const formData = new FormData();
    const isJson = typeof content === 'object' && !(content instanceof Blob);
    if (isJson) {
        const blob = new Blob([JSON.stringify(content)], { type: 'application/json' });
        formData.append('file', blob, `${publicId.split('/').pop()}.json`);
    } else {
        formData.append('file', content);
    }
    formData.append('api_key', process.env.CLOUDINARY_API_KEY);
    formData.append('timestamp', timestamp);
    formData.append('public_id', publicId);
    formData.append('signature', signature);
    formData.append('overwrite', 'true');
    formData.append('invalidate', 'true');

    const url = `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
    const resp = await fetch(url, { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Upload failed');
    return data.secure_url;
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ================================================================
// PUBLIC SITE VIEW (no auth — used by viewer.html)
// ================================================================
app.get('/api/public/site/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        console.log('🌍 Public site request:', id);

        // Validate UUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            console.error('❌ Invalid UUID format:', id);
            return res.status(400).json({ error: 'Invalid site ID' });
        }

        const { data, error } = await supabaseAdmin
            .from('sites')
            .select('id, name, data')
            .eq('id', id)
            .maybeSingle();

        console.log('📥 Query result:', { found: !!data, error: error?.message });

        if (error) {
            console.error('❌ Supabase error:', error);
            return res.status(500).json({ error: error.message });
        }
        if (!data) {
            return res.status(404).json({ error: 'Site not found' });
        }

        res.setHeader('Cache-Control', 'no-store');
        res.json(data);
    } catch (err) {
        console.error('❌ Public site exception:', err);
        res.status(500).json({ error: err.message });
    }
});

// ================================================================
// STATIC FILES
// ================================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ================================================================
// GLOBAL ERROR HANDLER
// ================================================================
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    if (SENTRY_DSN) Sentry.captureException(err);
    const message = NODE_ENV === 'production' ? 'Server error' : err.message;
    res.status(err.status || 500).json({ error: message });
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
    logger.info(`✅ Server running on port ${PORT}`);
    logger.info(`📝 Environment: ${NODE_ENV}`);
    logger.info(`🗄️  Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT CONFIGURED'}`);
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    if (SENTRY_DSN) Sentry.captureException(err);
});
process.on('unhandledRejection', (err) => {
    logger.error('Unhandled Rejection:', err);
    if (SENTRY_DSN) Sentry.captureException(err);
});