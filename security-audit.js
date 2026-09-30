// security-audit.js
// Runs security checks against your deployed site.
//
// Usage:
//   node security-audit.js                                                (uses BASE_URL below)
//   AUDIT_URL=https://staging.example.com node security-audit.js          (bash / macOS / Linux)
//   $env:AUDIT_URL='https://staging.example.com'; node security-audit.js  (Windows PowerShell)
//
// Exit code: 0 = no failures, 1 = at least one FAIL (CI friendly).

const BASE_URL = process.env.AUDIT_URL || 'https://podium-builder.onrender.com';

// ================================================================
// ANSI COLORS
// ================================================================
const c = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
};

const results = [];

// ================================================================
// HELPERS
// ================================================================
async function fetchJson(path, options = {}) {
    const url = BASE_URL + path;
    try {
        const resp = await fetch(url, {
            ...options,
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { ok: resp.ok, status: resp.status, text, json, headers: resp.headers };
    } catch (e) {
        return { ok: false, status: 0, error: e.message };
    }
}

function test(name, fn) {
    results.push({ name, fn });
}

// ================================================================
// PREFLIGHT
// Free-tier hosts (Render, Fly, Heroku) sleep when idle, so wake the
// site up before running the checks. Without this, the 10s per-request
// timeouts below report a page of false failures on a cold start.
// ================================================================
async function warmUp(maxAttempts = 6, timeoutMs = 30000, delayMs = 5000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await fetch(BASE_URL + '/health?_t=' + Date.now(), {
                cache: 'no-store',
                signal: AbortSignal.timeout(timeoutMs),
            });
            console.log(`  ${c.dim}Preflight: host awake after ${attempt} attempt(s) — status ${resp.status}${c.reset}`);
            return true;
        } catch (e) {
            const last = attempt === maxAttempts;
            console.log(`  ${c.yellow}⚠️  Preflight: attempt ${attempt}/${maxAttempts} failed${last ? '' : ' — retrying'} (${e.message})${c.reset}`);
        }
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
    }
    return false;
}

// ================================================================
// RUNNER
// ================================================================
async function runTests() {
    console.log(`\n${c.bold}${c.cyan}╔════════════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}${c.cyan}║  🔒 SECURITY AUDIT — ${BASE_URL.padEnd(38)}║${c.reset}`);
    console.log(`${c.bold}${c.cyan}╚════════════════════════════════════════════════════════════╝${c.reset}\n`);

    let passed = 0;
    let failed = 0;
    let warnings = 0;

    if (await warmUp()) {
        for (const { name, fn } of results) {
            try {
                const result = await fn();
                if (result.status === 'pass') {
                    console.log(`  ${c.green}✅ PASS${c.reset}  ${name}`);
                    if (result.detail) console.log(`         ${c.dim}${result.detail}${c.reset}`);
                    passed++;
                } else if (result.status === 'warn') {
                    console.log(`  ${c.yellow}⚠️  WARN${c.reset}  ${name}`);
                    if (result.detail) console.log(`         ${c.dim}${result.detail}${c.reset}`);
                    warnings++;
                } else {
                    console.log(`  ${c.red}❌ FAIL${c.reset}  ${name}`);
                    if (result.detail) console.log(`         ${c.dim}${result.detail}${c.reset}`);
                    failed++;
                }
            } catch (e) {
                console.log(`  ${c.red}❌ FAIL${c.reset}  ${name}`);
                console.log(`         ${c.dim}Exception: ${e.message}${c.reset}`);
                failed++;
            }
        }
    } else {
        console.log(`  ${c.red}❌ FAIL${c.reset}  Preflight: ${BASE_URL} did not respond`);
        console.log(`         ${c.dim}Check AUDIT_URL and that the service is running, then re-run.${c.reset}`);
        failed++;
    }

    console.log(`\n${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`  ${c.green}${passed} passed${c.reset}  ${c.yellow}${warnings} warnings${c.reset}  ${c.red}${failed} failed${c.reset}`);
    console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);

    return { passed, failed, warnings };
}

// ================================================================
// TEST 1: HTTPS redirect
// ================================================================
test('HTTPS: HTTP redirects to HTTPS', async () => {
    const httpUrl = BASE_URL.replace('https://', 'http://');
    try {
        const resp = await fetch(httpUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location') || '';
            if (loc.startsWith('https://')) {
                return { status: 'pass', detail: `Redirects to ${loc}` };
            }
            return { status: 'fail', detail: `Redirect location is not HTTPS: ${loc}` };
        }
        if (resp.status === 200) {
            return { status: 'warn', detail: 'HTTP is not redirected — consider forcing HTTPS' };
        }
        return { status: 'warn', detail: `Unexpected status: ${resp.status}` };
    } catch (e) {
        return { status: 'warn', detail: `HTTP request failed: ${e.message}` };
    }
});

// ================================================================
// TEST 2: Security headers (helmet)
// ================================================================
test('Security headers present (helmet)', async () => {
    const resp = await fetchJson('/');
    if (!resp.headers) return { status: 'fail', detail: 'No response' };
    const required = [
        'x-content-type-options',
        'x-frame-options',
        'strict-transport-security',
    ];
    const missing = required.filter(h => !resp.headers.get(h));
    if (missing.length === 0) {
        return { status: 'pass', detail: 'All key headers present' };
    }
    return { status: 'warn', detail: `Missing: ${missing.join(', ')}` };
});

// ================================================================
// TEST 3: /api/sites requires auth
// ================================================================
test('Auth: /api/sites rejects no token', async () => {
    const resp = await fetchJson('/api/sites');
    if (resp.status === 401) {
        return { status: 'pass', detail: 'Returns 401 without token' };
    }
    if (resp.status === 200) {
        return { status: 'fail', detail: 'CRITICAL: Sites accessible without auth!' };
    }
    return { status: 'warn', detail: `Unexpected status ${resp.status}` };
});

// ================================================================
// TEST 4: /api/sites rejects bad token
// ================================================================
test('Auth: /api/sites rejects invalid token', async () => {
    const resp = await fetchJson('/api/sites', {
        headers: { 'Authorization': 'Bearer invalid-token-here' },
    });
    if (resp.status === 401) {
        return { status: 'pass', detail: 'Returns 401 for bad token' };
    }
    if (resp.status === 200) {
        return { status: 'fail', detail: 'CRITICAL: Bad token accepted!' };
    }
    return { status: 'warn', detail: `Unexpected status ${resp.status}` };
});

// ================================================================
// TEST 5: PUT route requires auth
// ================================================================
test('Auth: PUT /api/sites/:id requires auth', async () => {
    const resp = await fetchJson('/api/sites/00000000-0000-0000-0000-000000000000', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hacked' }),
    });
    if (resp.status === 401) {
        return { status: 'pass', detail: 'Returns 401 without token' };
    }
    if (resp.status === 200) {
        return { status: 'fail', detail: 'CRITICAL: Unauthorized write allowed!' };
    }
    return { status: 'warn', detail: `Unexpected status ${resp.status}` };
});

// ================================================================
// TEST 6: DELETE route requires auth
// ================================================================
test('Auth: DELETE /api/sites/:id requires auth', async () => {
    const resp = await fetchJson('/api/sites/00000000-0000-0000-0000-000000000000', {
        method: 'DELETE',
    });
    if (resp.status === 401) {
        return { status: 'pass', detail: 'Returns 401 without token' };
    }
    if (resp.status === 200) {
        return { status: 'fail', detail: 'CRITICAL: Unauthorized delete allowed!' };
    }
    return { status: 'warn', detail: `Unexpected status ${resp.status}` };
});

// ================================================================
// TEST 7: Public endpoint is read-only
// ================================================================
test('Public: /api/public/site is read-only', async () => {
    const resp = await fetchJson('/api/public/site/00000000-0000-0000-0000-000000000000', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hacked' }),
    });
    if (resp.status === 404 || resp.status === 405 || resp.status === 401) {
        return { status: 'pass', detail: `Write rejected (${resp.status})` };
    }
    return { status: 'fail', detail: `Public endpoint accepted write: ${resp.status}` };
});

// ================================================================
// TEST 8: Health endpoint
// ================================================================
test('Health: /health responds OK', async () => {
    const resp = await fetchJson('/health');
    if (resp.ok && resp.json?.status === 'ok') {
        return { status: 'pass', detail: `Response: ${JSON.stringify(resp.json)}` };
    }
    return { status: 'warn', detail: `Status ${resp.status} — no /health route?` };
});

// ================================================================
// TEST 9: Login endpoint exists
// ================================================================
test('Auth: /api/login exists', async () => {
    const resp = await fetchJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@test.com', password: 'wrong' }),
    });
    if (resp.status === 400 || resp.status === 401) {
        return { status: 'pass', detail: `Returns ${resp.status} for bad login` };
    }
    if (resp.status === 404) {
        return { status: 'fail', detail: 'Login endpoint missing!' };
    }
    return { status: 'warn', detail: `Unexpected status ${resp.status}` };
});

// ================================================================
// TEST 10: Signup endpoint exists
// ================================================================
test('Auth: /api/signup exists', async () => {
    const resp = await fetchJson('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '', password: '' }),
    });
    if (resp.status === 400) {
        return { status: 'pass', detail: 'Returns 400 for empty input' };
    }
    if (resp.status === 404) {
        return { status: 'fail', detail: 'Signup endpoint missing!' };
    }
    return { status: 'warn', detail: `Unexpected status ${resp.status}` };
});

// ================================================================
// TEST 12: Sensitive env vars not exposed
// ================================================================
test('Secrets: service key not in frontend', async () => {
    const resp = await fetchJson('/dashboard.html');
    if (!resp.text) return { status: 'warn', detail: 'Could not fetch dashboard' };

    const sensitiveTerms = [
        'SUPABASE_SERVICE_KEY',
        'CLOUDINARY_API_SECRET',
        'JWT_SECRET',
        'service_role',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', // typical service key start
    ];

    const found = sensitiveTerms.filter(term => resp.text.includes(term));
    if (found.length === 0) {
        return { status: 'pass', detail: 'No secrets found in dashboard HTML' };
    }
    return { status: 'fail', detail: `SECRETS EXPOSED: ${found.join(', ')}` };
});

// ================================================================
// TEST 13: XSS sanitization
// ================================================================
test('XSS: script tags in input are escaped', async () => {
    // Try to log in and create a site with XSS payload
    // (only checks that the response doesn't reflect the script tag literally)
    // This is a heuristic — real XSS needs browser testing
    const resp = await fetchJson('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: `<script>alert(1)</script>@test.com`,
            password: 'testpassword123',
        }),
    });
    if (!resp.text) return { status: 'warn', detail: 'No response' };

    if (resp.text.includes('<script>')) {
        return { status: 'warn', detail: 'Script tag reflected in response — check escaping' };
    }
    return { status: 'pass', detail: 'Script tag not reflected in response' };
});

// ================================================================
// TEST 14: Invalid JSON handled gracefully
// ================================================================
test('Error handling: malformed JSON returns JSON error', async () => {
    const resp = await fetchJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not valid json',
    });
    if (resp.status >= 400 && resp.status < 500) {
        if (resp.json && resp.json.error) {
            return { status: 'pass', detail: `Returns JSON error: ${resp.json.error.substring(0, 60)}` };
        }
        if (resp.text.includes('<!DOCTYPE')) {
            return { status: 'warn', detail: 'Returns HTML error page instead of JSON' };
        }
    }
    return { status: 'warn', detail: `Status ${resp.status}` };
});

// ================================================================
// TEST 15: HTTPS certificate valid
// ================================================================
test('HTTPS: certificate is valid', async () => {
    try {
        const resp = await fetch(BASE_URL, { signal: AbortSignal.timeout(10000) });
        if (resp.ok || resp.status === 401) {
            return { status: 'pass', detail: 'HTTPS connection succeeded (cert valid)' };
        }
        return { status: 'warn', detail: `Status ${resp.status}` };
    } catch (e) {
        if (e.message.includes('certificate')) {
            return { status: 'fail', detail: `SSL error: ${e.message}` };
        }
        return { status: 'warn', detail: e.message };
    }
});

// ================================================================
// EXTRA CHECKS
// Added on top of the original 15. Two of them target this project
// specifically: express.static(__dirname) serves the whole repository,
// and GET /api/config hands the browser its Supabase credentials.
// Remove this block if you only want the original checklist.
// ================================================================

// ================================================================
// TEST 16: project source files are not downloadable
// ================================================================
test('Exposure: project source files are not public', async () => {
    const targets = ['/server.js', '/package.json', '/security-audit.js'];
    const reachable = [];
    const exposed = [];
    for (const file of targets) {
        const resp = await fetchJson(file);
        if (resp.status > 0) reachable.push(file);
        if (resp.status === 200 && resp.text) exposed.push(file);
    }
    if (reachable.length === 0) return { status: 'warn', detail: 'Could not reach the site' };
    if (exposed.length === 0) return { status: 'pass', detail: 'No project files are downloadable' };
    return {
        status: 'warn',
        detail: `Downloadable: ${exposed.join(', ')} — express.static(__dirname) serves the whole project root. No secrets inside these files, but consider moving the frontend into a public/ folder.`,
    };
});

// ================================================================
// TEST 17: /api/config exposes the anon key only
// ================================================================
test('Secrets: /api/config exposes anon key only', async () => {
    const resp = await fetchJson('/api/config');
    if (resp.status === 0) return { status: 'warn', detail: 'Could not reach /api/config' };
    if (!resp.json?.supabaseAnonKey) {
        return { status: 'warn', detail: `No browser config returned (status ${resp.status})` };
    }
    const body = resp.text || '';
    if (body.includes('SUPABASE_SERVICE_KEY') || body.includes('CLOUDINARY_API_SECRET') || body.includes('JWT_SECRET')) {
        return { status: 'fail', detail: 'CRITICAL: server secret names leaked in /api/config' };
    }
    try {
        const payload = JSON.parse(Buffer.from(resp.json.supabaseAnonKey.split('.')[1], 'base64url').toString('utf8'));
        if (payload.role && payload.role !== 'anon') {
            return { status: 'fail', detail: `CRITICAL: /api/config exposes a "${payload.role}" key` };
        }
        return { status: 'pass', detail: `Public anon key only (role: ${payload.role || 'unknown'})` };
    } catch (e) {
        return { status: 'warn', detail: 'Returned key is not a parseable JWT' };
    }
});

// ================================================================
// TEST 18: .env is not downloadable
// ================================================================
test('Secrets: .env is not downloadable', async () => {
    const resp = await fetchJson('/.env');
    if (resp.status === 0) return { status: 'warn', detail: 'Could not reach the site' };
    if (resp.status === 200) return { status: 'fail', detail: 'CRITICAL: .env is publicly downloadable!' };
    return { status: 'pass', detail: `.env blocked (HTTP ${resp.status})` };
});

// ================================================================
// TEST 19: CORS honours the origin allowlist
// ================================================================
test('CORS: only allowlisted origins are trusted', async () => {
    const evil = await fetchJson('/health', { headers: { 'Origin': 'https://evil.example' } });
    const self = await fetchJson('/health', { headers: { 'Origin': BASE_URL } });
    if (!evil.headers || !self.headers) return { status: 'warn', detail: 'No response headers' };

    const evilAcao = evil.headers.get('access-control-allow-origin');
    const selfAcao = self.headers.get('access-control-allow-origin');

    if (evilAcao) {
        const creds = evil.headers.get('access-control-allow-credentials') === 'true' ? ' with credentials:true' : '';
        return { status: 'warn', detail: 'Server reflects an unknown Origin (' + evilAcao + ')' + creds + ' — low risk while auth uses Bearer tokens, but tighten it to an allowlist' };
    }
    if (!selfAcao || selfAcao.toLowerCase() !== BASE_URL.toLowerCase()) {
        return { status: 'warn', detail: 'Unknown origins are blocked, but ' + BASE_URL + ' is not in the CORS allowlist' };
    }
    return { status: 'pass', detail: 'Unknown origins blocked; ' + BASE_URL + ' allowed' };
});

// ================================================================
// TEST 11: Rate limiting on login
// Runs LAST on purpose: it deliberately exhausts the login limiter, so
// running it earlier would poison the auth checks above it.
// ================================================================
test('Rate limit: login is throttled', async () => {
    // The attempts are sent one at a time so they all leave from the same
    // client address. Firing them in parallel makes a multi-homed runner
    // split them across two source IPs, which the limiter correctly treats
    // as two different clients (that produced false negatives before).
    const attempts = 15;
    let throttled = 0;
    let limitHeader = null;
    let remainingHeader = null;

    for (let i = 0; i < attempts; i++) {
        const resp = await fetchJson('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'audit@test.com', password: 'wrong' }),
        });
        if (resp.status === 429) throttled++;
        if (resp.headers) {
            limitHeader = resp.headers.get('ratelimit-limit') || limitHeader;
            remainingHeader = resp.headers.get('ratelimit-remaining') || remainingHeader;
        }
    }

    if (throttled > 0) {
        return { status: 'pass', detail: throttled + '/' + attempts + ' requests got 429 (Too Many Requests)' };
    }
    if (limitHeader) {
        return {
            status: 'warn',
            detail: 'Limiter is configured (RateLimit-Limit=' + limitHeader + ', remaining=' + remainingHeader + ') but ' + attempts + ' sequential failed logins never tripped it — check the store/key',
        };
    }
    return { status: 'fail', detail: 'No rate limiting detected on login endpoint' };
});

// ================================================================
// RUN
// ================================================================
runTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
});
