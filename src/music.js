// Music search over openly-licensed catalogs. Results carry the licence and a ready-made
// attribution line, because Creative Commons music must be credited when you use it.
//   Jamendo   (needs JAMENDO_CLIENT_ID, free at developer.jamendo.com)  - full tracks, artists opt in to downloads
//   Openverse (no key)                                                  - CC/public-domain audio from many sources
const TIMEOUT = 15000;
const cache = new Map();
const TTL = 5 * 60_000, CACHE_MAX = 200;
const UA = 'MAHNGUELOH-Developer-API/1.5';

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function licenseLabel(url, fallback) {
  const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/?([\d.]+)?/i.exec(url || '');
  if (m && m[1].toLowerCase() === 'publicdomain') return m[2].toLowerCase() === 'zero' ? `CC0${m[3] ? ' ' + m[3] : ''}` : 'Public Domain';
  if (m) return `CC ${m[2].toUpperCase()}${m[3] ? ' ' + m[3] : ''}`;
  return fallback ? String(fallback).toUpperCase() : 'Unknown';
}

function attribution(t) {
  return `"${t.title}" by ${t.artist} via ${t.source}. Licence: ${t.license}${t.license_url ? ' (' + t.license_url + ')' : ''}`;
}

async function jamendo(q, limit) {
  const id = process.env.JAMENDO_CLIENT_ID;
  if (!id) return [];
  const u = new URL('https://api.jamendo.com/v3.0/tracks/');
  for (const [k, v] of Object.entries({ client_id: id, format: 'json', limit: String(limit), search: q, audiodlformat: 'mp32', include: 'licenses' })) u.searchParams.set(k, v);
  const data = await getJson(u);
  return (data.results || [])
    .filter(t => t.audiodownload_allowed && /^https:\/\//.test(t.audiodownload || ''))
    .map(t => {
      const license_url = t.license_ccurl || '';
      const r = { id: `jamendo:${t.id}`, title: t.name, artist: t.artist_name, album: t.album_name || '', duration: Number(t.duration) || 0,
        thumbnail: t.image || '', source: 'Jamendo', page_url: t.shareurl || '', license: licenseLabel(license_url), license_url,
        audio: [{ quality: 'mp3 (VBR)', url: t.audiodownload }] };
      r.attribution = attribution(r);
      return r;
    });
}

async function openverse(q, limit) {
  const u = new URL('https://api.openverse.org/v1/audio/');
  u.searchParams.set('q', q); u.searchParams.set('category', 'music'); u.searchParams.set('page_size', String(limit));
  const data = await getJson(u);
  return (data.results || [])
    .filter(t => /^https:\/\//.test(t.url || ''))
    .map(t => {
      const license_url = t.license_url || '';
      const r = { id: `openverse:${t.id}`, title: t.title || 'Untitled', artist: t.creator || 'Unknown', album: '',
        duration: t.duration ? Math.round(t.duration / 1000) : 0, thumbnail: t.thumbnail || '',
        source: `Openverse (${t.source || t.provider || 'CC'})`, page_url: t.foreign_landing_url || '',
        license: licenseLabel(license_url, t.license ? `${t.license} ${t.license_version || ''}`.trim() : ''), license_url,
        audio: [{ quality: t.filetype || 'audio', url: t.url }] };
      r.attribution = attribution(r);
      return r;
    });
}

async function search(q, { limit = 10, commercial = false } = {}) {
  const key = `${q.toLowerCase()}|${limit}|${commercial}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.results;

  const settled = await Promise.allSettled([jamendo(q, limit), openverse(q, limit)]);
  if (settled.every(s => s.status === 'rejected')) {
    const e = new Error('Music sources are unavailable right now, retry shortly');
    e.status = 502;
    throw e;
  }
  const seen = new Set();
  let results = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : [])).filter(t => {
    const k = `${t.title}|${t.artist}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (commercial) results = results.filter(t => !/\bNC\b/i.test(t.license));
  results = results.slice(0, limit);

  cache.set(key, { expires: Date.now() + TTL, results });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return results;
}

module.exports = { search };
