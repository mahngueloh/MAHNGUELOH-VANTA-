// Blocks requests to private / internal networks (SSRF protection).
// A download gateway fetches URLs chosen by callers, so without this a caller
// could reach localhost, cloud metadata (169.254.169.254) or Railway's private
// network (*.railway.internal).
const net = require('net');
const dns = require('dns');

const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

function unmapV4(ip) {
  // ::ffff:127.0.0.1 and its hex form ::ffff:7f00:1 both mean 127.0.0.1
  let m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return m[1];
  m = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}

function isBlockedAddress(address) {
  const ip = unmapV4(String(address).replace(/^\[|\]$/g, '').split('%')[0]);
  const family = net.isIP(ip);
  if (!family) return true; // not an IP -> refuse
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function isBlockedHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  return false;
}

// Throws if the URL must not be fetched. Returns the parsed URL.
function assertPublicUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP/HTTPS URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('URL points to a disallowed address');
  } else {
    if (!host.includes('.') || isBlockedHostname(host)) throw new Error('URL points to a disallowed host');
  }
  return u;
}

// DNS lookup used by http/https. Checks the *resolved* IP, so DNS tricks
// (a public name that resolves to 127.0.0.1) and redirects are covered too.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter(a => !isBlockedAddress(a.address));
    if (!ok.length) return callback(new Error('URL resolves to a disallowed address'));
    if (options && options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

module.exports = { assertPublicUrl, safeLookup, isBlockedAddress };
