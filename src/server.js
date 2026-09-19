require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { assertPublicUrl, safeLookup } = require('./netguard');
const { version: VERSION } = require('../package.json');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_MB = Number(process.env.MAX_FILE_MB || 100);
const MAX_BYTES = MAX_MB * 1024 * 1024;
const TIMEOUT = Number(process.env.DOWNLOAD_TIMEOUT_MS || 30000);          // idle timeout
const TOTAL_TIMEOUT = Number(process.env.DOWNLOAD_TOTAL_TIMEOUT_MS || 120000); // hard cap per download
const FILE_TTL = Number(process.env.FILE_TTL_SECONDS || 3600);
const RATE = Number(process.env.RATE_LIMIT_PER_MINUTE || 60);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 5);
const MAX_STORAGE_BYTES = Number(process.env.MAX_STORAGE_MB || 500) * 1024 * 1024;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const TMP = path.join(__dirname, '..', 'temp');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

fs.mkdirSync(TMP, { recursive: true });
// Files tracked in memory are lost on restart, so clear orphans from the last run.
for (const f of fs.readdirSync(TMP)) {
  if (f !== '.gitkeep') { try { fs.unlinkSync(path.join(TMP, f)); } catch {} }
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Health check first, so Railway probes are never rate limited.
app.get('/health', (req, res) => res.json({ success: true, status: 'healthy', service: 'MAHNGUELOH Developer API', version: VERSION, uptime: Math.floor(process.uptime()) }));

app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60000, max: RATE * 2, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many requests' } }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const stats = { requests: 0, downloads: 0, bytes: 0, started: Date.now() };
const files = new Map();
let activeDownloads = 0;

// ---------- API keys (stored as SHA-256 hashes, persisted to DATA_DIR) ----------
const hashKey = k => crypto.createHash('sha256').update(k).digest('hex');
const keys = new Map(); // hash -> { name, prefix, created, requests, demo? }

try {
  const saved = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  for (const [h, item] of Object.entries(saved)) keys.set(h, item);
  console.log(`Loaded ${keys.size} API key(s) from ${KEYS_FILE}`);
} catch { /* first run or no volume yet */ }

let saveTimer = null;
function saveKeys() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushKeys, 2000);
  saveTimer.unref();
}
function flushKeys() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const [h, item] of keys) if (!item.demo) out[h] = item;
    const tmp = `${KEYS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, KEYS_FILE);
  } catch (e) { console.error('Could not persist API keys:', e.message); }
}

function makeKey() { return `mhg_${crypto.randomBytes(24).toString('hex')}`; }

if (process.env.DEMO_API_KEY) {
  keys.set(hashKey(process.env.DEMO_API_KEY), { name: 'Demo Developer', prefix: 'demo', created: Date.now(), requests: 0, demo: true });
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ success: false, error: 'API key required' });
  const hash = hashKey(h.slice(7).trim());
  const item = keys.get(hash);
  if (!item) return res.status(401).json({ success: false, error: 'Invalid API key' });
  item.requests++;
  if (!item.demo) saveKeys();
  req.apiKeyHash = hash;
  next();
}

function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(503).json({ success: false, error: 'Admin API key is not configured' });
  const h = req.headers.authorization || '';
  if (!safeEqual(h, `Bearer ${ADMIN_API_KEY}`)) return res.status(403).json({ success: false, error: 'Admin authorization required' });
  next();
}

const adminLimiter = rateLimit({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many admin requests' } });
const keyLimiter = rateLimit({ windowMs: 60000, max: RATE, standardHeaders: true, legacyHeaders: false, keyGenerator: req => req.apiKeyHash, message: { success: false, error: 'Rate limit exceeded for this API key' } });

// ---------- Downloading ----------
function safeName(url, headers) {
  let n = 'download';
  const cd = headers['content-disposition'] || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^;"']+)/i);
  if (m) { try { n = decodeURIComponent(m[1]); } catch { n = m[1]; } }
  else { try { n = path.basename(new URL(url).pathname) || n; } catch {} }
  return n.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'download';
}

function getStream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    let u;
    try { u = assertPublicUrl(url); } catch (e) { return reject(e); }
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(u, { lookup: safeLookup, headers: { 'User-Agent': `MAHNGUELOH-Developer-API/${VERSION}`, Accept: '*/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location) return reject(new Error('Redirect without location'));
        let next;
        try { next = new URL(res.headers.location, u).href; } catch { return reject(new Error('Bad redirect location')); }
        return resolve(getStream(next, redirects + 1)); // every hop is re-validated
      }
      resolve({ res, req });
    });
    req.setTimeout(TIMEOUT, () => req.destroy(new Error('Download timeout')));
    req.on('error', reject);
  });
}

async function downloadUrl(url) {
  const { res, req } = await getStream(url);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`Remote server returned HTTP ${res.statusCode}`);
  }
  const length = Number(res.headers['content-length'] || 0);
  if (length > MAX_BYTES) {
    res.resume();
    throw new Error(`File exceeds ${MAX_MB} MB limit`);
  }

  const id = crypto.randomBytes(12).toString('hex');
  const name = safeName(url, res.headers);
  const filePath = path.join(TMP, `${id}-${name}`);

  return await new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const out = fs.createWriteStream(filePath);
    const deadline = setTimeout(() => fail(new Error('Download took too long')), TOTAL_TIMEOUT);
    const fail = err => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      res.destroy();
      out.destroy();
      try { fs.unlinkSync(filePath); } catch {}
      reject(err);
    };
    res.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BYTES) fail(new Error(`File exceeds ${MAX_MB} MB limit`));
    });
    res.on('error', fail);
    res.on('aborted', () => fail(new Error('Remote server closed the connection early')));
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ id, name, size: total, path: filePath, type: res.headers['content-type'] || 'application/octet-stream' });
    });
    res.pipe(out);
  });
}

function storedBytes() {
  let n = 0;
  for (const f of files.values()) n += f.size;
  return n;
}

// ---------- Routes ----------
app.use((req, res, next) => { stats.requests++; next(); });

app.get('/api/stats', (req, res) => res.json({ success: true, stats: { requests: stats.requests, downloads: stats.downloads, bytes: stats.bytes, active_files: files.size, uptime: Math.floor((Date.now() - stats.started) / 1000) } }));

app.post('/api/keys', adminLimiter, adminAuth, (req, res) => {
  const key = makeKey();
  const name = String(req.body?.name || 'Developer').slice(0, 80);
  keys.set(hashKey(key), { name, prefix: key.slice(0, 10), created: Date.now(), requests: 0 });
  flushKeys();
  res.json({ success: true, name, key, note: 'Store this key now. It cannot be shown again.' });
});

app.get('/api/keys', adminLimiter, adminAuth, (req, res) => {
  const data = [...keys.values()].map(item => ({ key: `${item.prefix}...`, name: item.name, created: item.created, requests: item.requests }));
  res.json({ success: true, keys: data });
});

app.post('/v1/download', auth, keyLimiter, async (req, res) => {
  let u;
  try { u = assertPublicUrl(req.body?.url); }
  catch (e) { return res.status(400).json({ success: false, error: e.message || 'A valid public HTTP/HTTPS URL is required' }); }

  if (activeDownloads >= MAX_CONCURRENT) return res.status(429).json({ success: false, error: 'Server is busy, retry shortly' });
  if (storedBytes() >= MAX_STORAGE_BYTES) return res.status(503).json({ success: false, error: 'Temporary storage is full, retry shortly' });

  activeDownloads++;
  try {
    const f = await downloadUrl(u.href);
    files.set(f.id, { ...f, expires: Date.now() + FILE_TTL * 1000 });
    stats.downloads++;
    stats.bytes += f.size;
    const base = BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, id: f.id, filename: f.name, size: f.size, content_type: f.type, expires_in: FILE_TTL, download_url: `${base}/files/${f.id}` });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message || 'Download failed' });
  } finally {
    activeDownloads--;
  }
});

app.get('/files/:id', (req, res) => {
  const f = /^[a-f0-9]{24}$/.test(req.params.id) ? files.get(req.params.id) : null;
  if (!f || f.expires < Date.now()) {
    if (f) { try { fs.unlinkSync(f.path); } catch {} files.delete(req.params.id); }
    return res.status(404).json({ success: false, error: 'File not found or expired' });
  }
  res.download(f.path, f.name);
});

app.get('/api/docs', (req, res) => res.json({
  name: 'MAHNGUELOH Developer API', version: VERSION, authentication: 'Bearer API key',
  endpoints: [
    { method: 'GET', path: '/health', auth: false },
    { method: 'POST', path: '/v1/download', auth: true, body: { url: 'https://example.com/file.zip' } },
    { method: 'GET', path: '/files/:id', auth: false },
    { method: 'GET', path: '/api/stats', auth: false },
    { method: 'GET', path: '/api/docs', auth: false }
  ],
  limits: { max_file_mb: MAX_MB, timeout_ms: TIMEOUT, file_ttl_seconds: FILE_TTL, rate_limit_per_minute: RATE }
}));

// Unknown API paths return JSON, not the website.
app.all(['/api/*', '/v1/*', '/files/*'], (req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Request body too large' });
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

setInterval(() => {
  for (const [id, f] of files) {
    if (f.expires < Date.now()) { try { fs.unlinkSync(f.path); } catch {} files.delete(id); }
  }
}, 5 * 60 * 1000).unref();

const server = app.listen(PORT, () => console.log(`MAHNGUELOH Developer API v${VERSION} listening on :${PORT}`));

// Railway sends SIGTERM on redeploy: save keys and stop cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flushKeys();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
