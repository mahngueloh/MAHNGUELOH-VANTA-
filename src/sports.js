// Football data proxy (football-data.org). Same paths and response shape the old relay used:
//   { success: true, data: <football-data.org response> }
// The upstream token lives in FOOTBALL_DATA_TOKEN (free token: https://www.football-data.org/client/register)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['SCHEDULED', 'TIMED', 'LIVE', 'IN_PLAY', 'PAUSED', 'FINISHED', 'POSTPONED', 'CANCELED']);

const ROUTES = [
  { path: '/sports/matches',                   code: 'PL',  type: 'matches',   title: 'Premier League Matches',  description: 'Get Premier League matches (past and upcoming)' },
  { path: '/sports/laliga-matches',            code: 'PD',  type: 'matches',   title: 'La Liga Matches',         description: 'Get La Liga matches (past and upcoming)' },
  { path: '/sports/bundesliga-matches',        code: 'BL1', type: 'matches',   title: 'Bundesliga Matches',      description: 'Get Bundesliga matches (past and upcoming)' },
  { path: '/sports/seriea-matches',            code: 'SA',  type: 'matches',   title: 'Serie A Matches',         description: 'Get Serie A matches (past and upcoming)' },
  { path: '/sports/ligue1-matches',            code: 'FL1', type: 'matches',   title: 'Ligue 1 Matches',         description: 'Get Ligue 1 matches (past and upcoming)' },
  { path: '/sports/champions-league-matches',  code: 'CL',  type: 'matches',   title: 'Champions League Matches', description: 'Get UEFA Champions League matches (past and upcoming)' },
  { path: '/sports/epl-standings',             code: 'PL',  type: 'standings', title: 'EPL Standings',           description: 'Get the latest Premier League standings' },
  { path: '/sports/epl-scorers',               code: 'PL',  type: 'scorers',   title: 'EPL Top Scorers',         description: 'Get the Premier League top scorers' }
];

const cache = new Map(); // url -> { expires, data }
const CACHE_MAX = 200;
const TTL = { matches: 60_000, standings: 300_000, scorers: 300_000 };
const UPSTREAM_PER_MIN = () => Number(process.env.SPORTS_UPSTREAM_PER_MINUTE || 8); // free tier allows 10/min
let windowStart = 0, windowCount = 0;

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function upstreamAllowed() {
  const now = Date.now();
  if (now - windowStart >= 60_000) { windowStart = now; windowCount = 0; }
  if (windowCount >= UPSTREAM_PER_MIN()) return false;
  windowCount++;
  return true;
}

async function football(pathAndQuery, ttl) {
  const hit = cache.get(pathAndQuery);
  if (hit && hit.expires > Date.now()) return hit.data;

  const token = process.env.FOOTBALL_DATA_TOKEN || '';
  if (!token) throw httpError(503, 'FOOTBALL_DATA_TOKEN is not configured on the server');
  if (!upstreamAllowed()) throw httpError(429, 'Sports data budget used up for this minute, retry shortly');

  const res = await fetch(`https://api.football-data.org/v4${pathAndQuery}`, { headers: { 'X-Auth-Token': token }, signal: AbortSignal.timeout(15000) });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !data || data.errorCode) {
    const msg = (data && data.message) || `Upstream HTTP ${res.status}`;
    if (res.status === 429) throw httpError(429, 'Sports provider rate limit reached, retry shortly');
    if (res.status === 400 || res.status === 404) throw httpError(res.status, msg);
    throw httpError(502, msg);
  }
  cache.set(pathAndQuery, { expires: Date.now() + ttl, data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return data;
}

function queryString(route, q) {
  const p = new URLSearchParams();
  const str = v => (typeof v === 'string' ? v.trim() : v === undefined ? '' : null);
  if (route.type === 'matches') {
    const from = str(q.dateFrom), to = str(q.dateTo), status = str(q.status);
    if (from === null || to === null || status === null) throw httpError(400, 'Invalid query parameters');
    if (!!from !== !!to) throw httpError(400, 'dateFrom and dateTo must be used together');
    if (from) {
      if (!DATE_RE.test(from) || !DATE_RE.test(to) || isNaN(Date.parse(from)) || isNaN(Date.parse(to))) throw httpError(400, 'Dates must be YYYY-MM-DD');
      p.set('dateFrom', from); p.set('dateTo', to);
    }
    if (status) {
      if (!STATUSES.has(status.toUpperCase())) throw httpError(400, `status must be one of ${[...STATUSES].join(', ')}`);
      p.set('status', status.toUpperCase());
    }
  } else if (route.type === 'scorers') {
    const limit = str(q.limit);
    if (limit === null) throw httpError(400, 'Invalid query parameters');
    if (limit) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw httpError(400, 'limit must be a whole number from 1 to 50');
      p.set('limit', String(n));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function makeHandler(route) {
  return async (req, res) => {
    try {
      const qs = queryString(route, req.query || {});
      const suffix = route.type === 'matches' ? 'matches' : route.type;
      const data = await football(`/competitions/${route.code}/${suffix}${qs}`, TTL[route.type]);
      res.json({ success: true, data });
    } catch (e) {
      res.status(e.status || 502).json({ success: false, error: e.message });
    }
  };
}

module.exports = { ROUTES, makeHandler };
