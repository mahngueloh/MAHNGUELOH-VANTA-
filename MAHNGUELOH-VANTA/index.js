'use strict'

// Self-heal on startup: install dependencies when node_modules is missing OR
// when the deployed Baileys version does not match this project's pinned
// version. This matters after uploading a new ZIP to a panel that preserves
// the old node_modules directory.
try {
    const pkg = require('./package.json')
    const wantedBaileys = pkg.dependencies?.['@whiskeysockets/baileys']
    require.resolve('dotenv')
    const installedBaileys = require('@whiskeysockets/baileys/package.json').version
    if (wantedBaileys && installedBaileys !== wantedBaileys) {
        throw new Error(`Baileys ${installedBaileys} installed, ${wantedBaileys} required`)
    }
} catch (e) {
    console.log(`[ SETUP ] ${e.message || 'Dependencies missing'} — running npm install (this can take a minute)...`)
    require('child_process').execSync('npm install', { stdio: 'inherit', cwd: __dirname })
    console.log('[ SETUP ] Install complete')
}

require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// Keep the process alive indefinitely even if every socket/timer is torn
// down (e.g. after giving up on a dead session below). Without this, an
// empty event loop lets Node exit on its own — and on hosts that auto-
// restart the process the instant it exits, that turns a clean "give up"
// into an invisible infinite restart loop.
setInterval(() => {}, 24 * 60 * 60 * 1000)

// ── Persisted quick-disconnect streak ───────────────────────────────────────
// An in-memory counter doesn't survive a process restart. Some hosts
// auto-restart the process the instant it exits (any exit code), which
// silently resets any in-memory "give up after N failures" counter back to
// zero — so what should be a clean stop instead looks like the bot
// reconnecting forever. Persisting the streak to disk closes that gap: the
// count survives restarts, so the give-up logic actually gives up.
const healthPath = path.join(__dirname, 'data', 'session-health.json')
function loadStreak() {
    try { return JSON.parse(fs.readFileSync(healthPath, 'utf8')).streak || 0 } catch { return 0 }
}
function saveStreak(n) {
    try {
        fs.mkdirSync(path.dirname(healthPath), { recursive: true })
        fs.writeFileSync(healthPath, JSON.stringify({ streak: n, updatedAt: Date.now() }))
    } catch {}
}

// Always ensure a real, editable .env exists — dotenv.config() only READS a
// file, it never creates one. This is ALSO run from package.json's
// postinstall (scripts/ensure-env.js) so the file exists right after a
// fresh install, before you ever press Start — this call here is just a
// safety net for the rare case postinstall didn't run.
require('./scripts/ensure-env').ensureEnvFile(__dirname)

// Silences noisy libsignal-node debug prints (not routed through the logger)
const NOISY_PATTERNS = [
    /Closing (stale open|open) session/i,
    /Closing session:/i,
    /SessionEntry\s*\{/,
]

// ── Self-healing session recovery ───────────────────────────────────────────
// Repeated "Bad MAC" errors are a known Baileys/libsignal failure mode.
// They can leave incoming-message decryption stuck while the WebSocket still
// looks connected. We recover conservatively rather than blindly deleting the
// whole auth database.
let badMacHits = 0
let badMacWindowStart = Date.now()
let recoveryInFlight = false
let lastRecoveryAt = 0
let badMacRecoveries = 0
let badMacRecoveryWindowStart = Date.now()
const badMacSessionIds = new Set()

// Bad-MAC is a known Baileys/libsignal failure mode. In particular, deleting
// every session file immediately is NOT a reliable universal fix: upstream
// reports show some problematic IDs (especially group/broadcast/LID sessions)
// can be recreated and continue failing. The safer strategy is:
//   1) reconnect once using the current persisted auth state;
//   2) only if the same problem returns, delete the specifically implicated
//      session file(s), not the whole Signal database;
//   3) never create a reconnect storm.
const BAD_MAC_THRESHOLD          = 3
const BAD_MAC_WINDOW_MS          = 60_000
const RECOVERY_COOLDOWN_MS       = 180_000
const MAX_TARGETED_CLEANUPS      = 2
const RECOVERY_WINDOW_MS         = 15 * 60_000

function noteBadMacSessionIds(text) {
    // Examples emitted by libsignal/Baileys include:
    //   "at async 25472577602.0 [as awaitable]"
    //   "at async 123456789012345_1.0 [as awaitable]"
    const patterns = [
        /\bat async ([A-Za-z0-9._:-]+) \[as awaitable\]/g,
        /\b(?:session|jid)[=: ]+['"]?([0-9]{7,24}(?:[_:.][A-Za-z0-9._:-]+)*)['"]?/gi,
    ]
    for (const re of patterns) {
        for (const m of String(text || '').matchAll(re)) {
            if (m[1] && m[1].length <= 80) badMacSessionIds.add(m[1])
        }
    }
}

function targetedSessionFiles() {
    const authDir = path.join(__dirname, 'auth_info')
    const files = []
    try {
        for (const f of fs.readdirSync(authDir)) {
            if (!/^session-.*\.json$/.test(f)) continue
            if (!badMacSessionIds.size) continue
            const base = f.replace(/^session-/, '').replace(/\.json$/, '')
            for (const id of badMacSessionIds) {
                if (base === id || base.startsWith(`${id}_`) || base.startsWith(`${id}.`)) {
                    files.push(f)
                    break
                }
            }
        }
    } catch (e) {
        console.log('[ RECOVER ] Could not inspect auth_info:', e.message)
    }
    return [...new Set(files)]
}

function wipeTargetedCorruptedSessions() {
    const authDir = path.join(__dirname, 'auth_info')
    const files = targetedSessionFiles()
    let cleared = 0
    for (const f of files) {
        try { fs.unlinkSync(path.join(authDir, f)); cleared++ } catch {}
    }
    return { cleared, files }
}

function maybeRecoverFromBadMac(text) {
    noteBadMacSessionIds(text)
    const now = Date.now()

    if (now - badMacWindowStart > BAD_MAC_WINDOW_MS) {
        badMacWindowStart = now
        badMacHits = 0
    }
    badMacHits++

    if (now - badMacRecoveryWindowStart > RECOVERY_WINDOW_MS) {
        badMacRecoveryWindowStart = now
        badMacRecoveries = 0
    }

    if (badMacHits < BAD_MAC_THRESHOLD) return
    if (recoveryInFlight || now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return

    recoveryInFlight = true
    lastRecoveryAt = now
    badMacHits = 0
    badMacRecoveries++

    setTimeout(async () => {
        try {
            // First recovery is deliberately a clean socket restart with the
            // CURRENT auth_info. This is important because SESSION_ID in .env
            // may be stale; restoreSessionFromConfig() now refuses to overwrite a
            // healthy persisted auth state during reconnects.
            if (badMacRecoveries > 1 && badMacRecoveries <= MAX_TARGETED_CLEANUPS) {
                const result = wipeTargetedCorruptedSessions()
                if (result.cleared) {
                    console.log(`[ RECOVER ] Bad MAC persisted — cleared ${result.cleared} targeted Signal session file(s): ${result.files.join(', ')}`)
                } else {
                    console.log('[ RECOVER ] Bad MAC persisted, but no implicated session file could be mapped; reconnecting with current auth state.')
                }
            } else {
                console.log('[ RECOVER ] Reconnecting with current auth state after repeated Bad MAC errors...')
            }
            scheduleReconnect(1500, 'bad-mac')
        } catch (e) {
            console.log('[ RECOVER ] recovery failed:', e.message)
            scheduleReconnect(5000, 'bad-mac-recovery-failed')
        } finally {
            recoveryInFlight = false
        }
    }, 250)
}

function filterWrite(origWrite) {
    return function (chunk, ...rest) {
        const str = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') || ''
        if (/Bad MAC/i.test(str)) maybeRecoverFromBadMac(str)
        if (NOISY_PATTERNS.some(p => p.test(str))) return true // pretend it was written
        return origWrite.call(this, chunk, ...rest)
    }
}
process.stdout.write = filterWrite(process.stdout.write.bind(process.stdout))
process.stderr.write = filterWrite(process.stderr.write.bind(process.stderr))

const { logEnvDiagnostics } = require('./lib/envCheck')
logEnvDiagnostics()

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    proto,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys')
const { Boom }  = require('@hapi/boom')
const pino      = require('pino')
const config    = require('./config')
const fmt       = require('./lib/format')
const { getBody, getSender, isOwner } = require('./lib/utils')
const msgStore  = require('./lib/messageStore')
const { printErrorBox } = require('./lib/errorBox')
const { runtimeSettings, STATUS_EMOJIS } = require('./plugins/ownerCmds')
const uncachedNoticeCooldown = new Map()
let lastMsgContext = {}
const { handleMessage }    = require('./handler')
const { handleGroupEvents } = require('./plugins/groups')
const { ensureYtdlp }      = require('./plugins/downloader')
const { initNewsMonitor }  = require('./plugins/newsMonitor')

const log     = pino({ level: 'silent' })
const seen    = new Set()
const rateMap = new Map()
let onlineSent = false, retries = 0, retryTimer = null, sock = null, bannerShown = false, statusReportShown = false, joinedUpdatesGroup = false, lastOpenAt = 0, quickDisconnectStreak = loadStreak()
let connectPromise = null
let socketGeneration = 0

function scheduleReconnect(delayMs, reason = 'connection') {
    if (retryTimer) return
    retryTimer = setTimeout(() => {
        retryTimer = null
        connect().catch(e => printErrorBox('Reconnect Error', e, lastMsgContext))
    }, Math.max(0, Number(delayMs) || 0))
    if (reason) console.log(`[ CONN ] Reconnect scheduled in ${Math.ceil(Math.max(0, Number(delayMs) || 0) / 1000)}s (${reason})`)
}

function cleanupSocket() {
    if (!sock) return
    try { sock.ev.removeAllListeners() } catch {}
    try { sock.end(new Error('reconnecting')) } catch {}
    sock = null
}

function dedup(id) {
    if (!id || seen.has(id)) return false
    seen.add(id)
    if (seen.size > 2000) {
        const a = [...seen]; seen.clear(); a.slice(-1000).forEach(i => seen.add(i))
    }
    return true
}

function rateOk(jid) {
    const now = Date.now(), last = rateMap.get(jid) || 0
    if (now - last < 2000) return false
    rateMap.set(jid, now)
    return true
}

function showCode(code, phone) {
    // Format as XXXX-XXXX
    const show = (code || '').replace(/\W/g, '').match(/.{1,4}/g)?.join('-') || code
    console.log('\n' + '━'.repeat(52))
    console.log('  🔑  PAIRING CODE  →  ' + show)
    console.log('━'.repeat(52))
    console.log('\n  Steps to link on WhatsApp:')
    console.log('  1. Open WhatsApp → tap ⋮ (3-dot menu)')
    console.log('  2. Linked Devices → Link a Device')
    console.log('  3. Tap "Link with phone number"')
    console.log('  4. Enter your number: ' + phone)
    console.log('  5. Enter the code above')
    console.log('\n  ⚠  Code expires in ~60 seconds.')
    console.log('     If it says invalid → delete the auth_info')
    console.log('     folder and restart the bot for a fresh code.\n')
}

const MSG_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m']
let msgColorIdx = 0
function printMessageLog(ctx, text) {
    const reset = '\x1b[0m'
    const c1 = MSG_COLORS[msgColorIdx % MSG_COLORS.length]
    const c2 = MSG_COLORS[(msgColorIdx + 1) % MSG_COLORS.length]
    msgColorIdx++
    const bar = '─'.repeat(18)
    const now = new Date()

    console.log(`${c1}${bar}${reset}⌐ ${c2}${config.botName}${reset} ⌐${c1}${bar}${reset}`)
    console.log(`» Sent Time: ${now.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}`)
    console.log(`» Date: ${now.toLocaleDateString('en-GB')}`)
    console.log(`» Message Type: ${ctx.messageType}`)
    console.log(`» Sender Name: ${ctx.senderName}`)
    console.log(`» Chat ID: ${ctx.chatId}`)
    console.log(`» Text: ${text}`)
    console.log(`${c2}${bar}${reset}⌐⌐${c1}${bar}${reset}`)
}

function printBootBanner(needsPairing, version) {
    const C = {
        reset:'\x1b[0m',
        bold:'\x1b[1m',
        cyan:'\x1b[36m',
        green:'\x1b[32m',
        yellow:'\x1b[33m',
        magenta:'\x1b[35m',
        gray:'\x1b[90m'
    }

    let pluginCount = 0
    try {
        pluginCount = fs.readdirSync(path.join(__dirname, 'plugins'))
            .filter(f => f.endsWith('.js')).length
    } catch {}

    const mode = config.mode === 'public' ? 'PUBLIC' : 'PRIVATE'
    const auth = needsPairing ? 'PAIRING REQUIRED' : 'SESSION READY'
    const uptimeSec = process.uptime()
    const hours = Math.floor(uptimeSec / 3600)
    const minutes = Math.floor((uptimeSec % 3600) / 60)

    const line = (label, value) =>
        console.log(`┃ ${C.gray}${label.padEnd(12)}${C.reset}: ${value}`)

    console.log('')
    console.log(`${C.cyan}╭──────────────────────────────────────────────────╮${C.reset}`)
    console.log(`${C.cyan}│${C.reset}     ${C.bold}${C.magenta}◆  M A H N G U E L O H   V A N T A  ◆${C.reset}     ${C.cyan}│${C.reset}`)
    console.log(`${C.cyan}│${C.reset}         ${C.bold}We are Anonymous. We are Legion…${C.reset}         ${C.cyan}│${C.reset}`)
    console.log(`${C.cyan}╰──────────────────────────────────────────────────╯${C.reset}`)

    console.log(`\n${C.magenta}${C.bold}╭─〔 VANTA BOOT SEQUENCE 〕────────────────────────╮${C.reset}`)
    line('Protocol', `${C.bold}ANONYMOUS${C.reset}`)
    line('Identity', `${C.bold}VANTA CORE${C.reset}`)
    line('Mode', mode === 'PUBLIC' ? `${C.green}${mode}${C.reset}` : `${C.yellow}${mode}${C.reset}`)
    line('Prefix', `[ ${config.prefix} ]`)
    line('Owner', config.ownerName)
    line('Plugins', `${C.green}${pluginCount} loaded${C.reset}`)
    line('Version', `v${config.version || '3.1.0'}`)
    line('Auth', needsPairing ? `${C.yellow}${auth}${C.reset}` : `${C.green}${auth}${C.reset}`)
    console.log(`${C.magenta}╰──────────────────────────────────────────────────╯${C.reset}`)

    console.log(`\n${C.cyan}${C.bold}╭─〔 CORE RUNTIME 〕────────────────────────────────╮${C.reset}`)
    line('Node.js', process.version)
    line('Platform', `${os.platform()} ${os.arch()}`)
    line('Baileys', version.join('.'))
    line('Uptime', `${hours}h ${minutes}m`)
    line('Status', `${C.green}INITIALIZING${C.reset}`)
    console.log(`${C.cyan}╰──────────────────────────────────────────────────╯${C.reset}`)

    console.log(`\n${C.magenta}${C.bold}✦ VANTA IS PREPARING THE CONNECTION LAYER...${C.reset}`)
    console.log(`${C.gray}  ${config.themeLine || 'We are Anonymous. We are Legion…'}${C.reset}`)
    console.log('')
}

function printStatusReport(phone, version) {
    const C = { reset:'\x1b[0m', bold:'\x1b[1m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', gray:'\x1b[90m' }
    const on  = `${C.green}✓ ON${C.reset}`
    const off = `${C.red}✗ OFF${C.reset}`
    const ok  = (s) => `${C.green}✓ ${s}${C.reset}`

    let pluginCount = 0
    try { pluginCount = fs.readdirSync(path.join(__dirname, 'plugins')).filter(f => f.endsWith('.js')).length } catch {}

    const maskedPhone = phone ? phone.slice(0, 3) + '*'.repeat(Math.max(0, phone.length - 6)) + phone.slice(-3) : 'unknown'
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024)

    const line = (label, value) => console.log(`  ${C.gray}${label.padEnd(10)}${C.reset}: ${value}`)

    console.log(`\n${C.cyan}${C.bold}◆ CONFIGURATION${C.reset}`)
    line('Prefix', config.prefix)
    line('Mode', config.mode === 'public' ? ok('PUBLIC') : `${C.yellow}PRIVATE${C.reset}`)
    line('Owner', config.ownerName)
    line('Plugins', ok(`${pluginCount} loaded`))

    console.log(`\n${C.cyan}${C.bold}◆ RUNTIME${C.reset}`)
    line('Node.js', process.version)
    line('Platform', `${os.platform()} ${os.arch()}`)
    line('Memory', `${memMb} MiB`)
    line('Baileys', version.join('.'))

    console.log(`\n${C.cyan}${C.bold}◆ TOGGLES${C.reset}`)
    const entries = Object.entries(runtimeSettings)
    for (let i = 0; i < entries.length; i += 2) {
        const [k1, v1] = entries[i]
        const [k2, v2] = entries[i + 1] || []
        const left  = `${k1.padEnd(18)}: ${v1 ? on : off}`
        const right = k2 ? `${k2.padEnd(18)}: ${v2 ? on : off}` : ''
        console.log(`  ${left}  ${right}`)
    }

    console.log(`\n${C.cyan}${C.bold}◆ CONNECTION${C.reset}`)
    line('WhatsApp', ok('connected'))
    line('Account', `+${maskedPhone}`)
    console.log('')
}

// ── Session ID restore (from the MAHNGUELOH MD SESSION pairing site) ───────
// Decodes a "MAHNGUELOH~<base64 gzip>" SESSION_ID from config.js (or optional .env override) into ./auth_info
// BEFORE useMultiFileAuthState reads it, so if it's valid, Baileys sees an
// already-registered session and skips pairing-code requests entirely.
// Get a session ID at https://mahngueloh-md-session.onrender.com/
const SESSION_PREFIX = 'MAHNGUELOH~'
// Pure decode check — no file writes — so both the real restore below and
// the console-paste listener further down can ask "is this actually a
// complete, decodable session yet?" without duplicating the zlib logic.
function tryDecodeSessionId(sessionId) {
    try {
        const zlib = require('zlib')
        const gz = Buffer.from(sessionId.slice(SESSION_PREFIX.length), 'base64')
        const bundle = JSON.parse(zlib.gunzipSync(gz).toString('utf8'))
        return { ok: true, bundle }
    } catch (e) {
        const truncated = /unexpected end of file|incorrect header check|invalid.*base64/i.test(e.message)
        return { ok: false, truncated, error: e.message }
    }
}

function restoreSessionFromConfig() {
    // SESSION_ID is a bootstrap credential, not the live auth database. Never
    // overwrite a healthy auth_info on reconnect, otherwise every reconnect
    // would roll the Signal ratchet back to an old snapshot and can itself
    // manufacture the exact Bad MAC/desync cycle we're trying to recover.
    const credsPath = path.join(__dirname, 'auth_info', 'creds.json')
    try {
        const existing = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        if (existing?.registered === true) {
            return false
        }
    } catch {}

    let sessionId = (config.sessionId || process.env.SESSION_ID || '').trim()

    // Forgiving fallback: if SESSION_ID itself isn't valid (e.g. someone
    // pasted the whole pairing-site message — label text and all — instead
    // of just the ID), scan the raw .env file for a bare "MAHNGUELOH~..."
    // line anywhere and use that instead. Cheap safety net for an easy
    // copy-paste mistake.
    if (!sessionId.startsWith(SESSION_PREFIX)) {
        try {
            const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
            const found = raw.split('\n').map(l => l.trim()).find(l => l.startsWith(SESSION_PREFIX))
            if (found) {
                sessionId = found
                console.log('[ SESSION ] Found a session ID elsewhere in .env (not on the SESSION_ID= line) — using it anyway')
            }
        } catch {}
    }

    if (!sessionId) return false
    if (!sessionId.startsWith(SESSION_PREFIX)) {
        console.log('[ SESSION ] SESSION_ID is set but not a valid MAHNGUELOH session (missing prefix) — ignoring')
        return false
    }
    const decoded = tryDecodeSessionId(sessionId)
    if (decoded.ok) {
        const authDir = path.join(__dirname, 'auth_info')
        fs.mkdirSync(authDir, { recursive: true })
        for (const [file, content] of Object.entries(decoded.bundle)) {
            const full = path.join(authDir, file)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, content, 'utf8')
        }
        console.log(`[ SESSION ] Restored ${Object.keys(decoded.bundle).length} file(s) from SESSION_ID — skipping pairing code`)
        return true
    }
    console.log(`[ SESSION ] Failed to restore SESSION_ID (${sessionId.length} chars received): ${decoded.error}`)
    if (decoded.truncated) {
        console.log('[ SESSION ] This looks like the paste got cut off partway through — a real Session ID')
        console.log('[ SESSION ] is usually several thousand characters, and long console pastes on some')
        console.log('[ SESSION ] hosts get truncated. Two more reliable options:')
        console.log('[ SESSION ]   1. Phone Number pairing instead — much shorter, far less likely to get cut off.')
        console.log('[ SESSION ]   2. Paste the FULL Session ID into config.js instead of the console.')
    }
    return false
}

function printLoginMenu(hasSessionId, hasPhone) {
    const C = { reset: '\x1b[0m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', gray: '\x1b[90m' }
    console.log(`\n${C.cyan}No login configured yet — pick ONE of these${C.reset} :`)
    console.log(`${C.yellow}1.${C.reset} ${hasSessionId ? C.green + '✓' : C.gray + '✗'} Session ID${C.reset}  — get one from ${C.cyan}https://mahngueloh-md-session.onrender.com/${C.reset}, then open ${C.cyan}config.js${C.reset} and set ${C.cyan}sessionId${C.reset} to the full Session ID`)
    console.log(`${C.yellow}2.${C.reset} ${hasPhone ? C.green + '✓' : C.gray + '✗'} Phone Number${C.reset}  — in the ${C.cyan}Files${C.reset} tab open ${C.cyan}.env${C.reset} and set ${C.cyan}PHONE_NUMBER=${C.reset}<your number, digits only, with country code>`)
    console.log(`${C.gray}Then hit ${C.reset}Restart${C.gray} in this panel — this box only reads .env on startup, it does not read what you type here.${C.reset}\n`)
}

function saveSessionIdToConfig(sessionId) {
    try {
        const cfgPath = path.join(__dirname, 'config.js')
        let src = fs.readFileSync(cfgPath, 'utf8')
        const escaped = String(sessionId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const line = `    sessionId: process.env.SESSION_ID || '${escaped}',`
        if (/^    sessionId: process.env\.SESSION_ID \|\| .*,$/m.test(src)) {
            src = src.replace(/^    sessionId: process.env\.SESSION_ID \|\| .*,$/m, line)
        } else {
            throw new Error('sessionId entry not found in config.js')
        }
        fs.writeFileSync(cfgPath, src, 'utf8')
    } catch (e) {
        console.log('[ SESSION ] Could not save Session ID to config.js:', e.message)
    }
}

function appendEnv(key, value) {
    const envPath = path.join(__dirname, '.env')
    let content = ''
    try { content = fs.readFileSync(envPath, 'utf8') } catch {}
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith(`${key}=`))
    lines.push(`${key}=${value}`)
    fs.writeFileSync(envPath, lines.join('\n') + '\n')
}

async function connect() {
    if (connectPromise) return connectPromise
    const generation = ++socketGeneration
    connectPromise = (async () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    cleanupSocket()  // tear down any previous socket before making a new one

    const sessionRestored = restoreSessionFromConfig()
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

    // A pure hardcoded pin (what this used to be) is actually the WRONG fix:
    // WhatsApp actively deprecates old protocol version numbers and starts
    // rejecting them with exactly this "405 Connection Failure" once they
    // age out — confirmed by multiple recent Baileys issues (e.g. #2376,
    // #2679) where a stale hardcoded/cached version caused 405 loops.
    // So: fetch live, but never trust a fetch result OLDER than a known
    // baseline — fetchLatestBaileysVersion() has also been observed
    // returning a stale cached value while claiming isLatest:true. Taking
    // the max of (fetched, baseline) protects against both failure modes:
    // a stale fetch, and a fetch that fails outright.
    // Bump BASELINE_VERSION every so often (check https://wppconnect.io/whatsapp-versions/
    // if 405 loops start again) — even this safety net goes stale eventually.
    const BASELINE_VERSION = [2, 3000, 1042466098]
    const cmpVersion = (a, b) => (a[0]-b[0]) || (a[1]-b[1]) || (a[2]-b[2])

    let version = BASELINE_VERSION
    try {
        const r = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ])
        if (cmpVersion(r.version, BASELINE_VERSION) >= 0) {
            version = r.version
            console.log(`[ VER ] Baileys protocol ${version.join('.')} (fetched)`)
        } else {
            console.log(`[ VER ] fetchLatestBaileysVersion returned stale ${r.version.join('.')} — using baseline ${version.join('.')} instead`)
        }
    } catch {
        console.log(`[ VER ] Fetch failed/timed out — using baseline Baileys protocol ${version.join('.')}`)
    }

    // Sanitise phone number — digits only, with country code, no +
    let phone = (config.ownerNumber || '').replace(/\D/g, '')
    let needsPairing = !state.creds.registered

    if (!bannerShown) {
        bannerShown = true
        printBootBanner(needsPairing, version)
    }

    // Update, 2026-09-05: confirmed with a real test (a different bot on this
    // same host DID receive a long pasted Session ID via the console box) —
    // console input CAN reach process.stdin here after all. The stdin
    // listener further down in this file handles it; this menu just prints
    // the options regardless, since .env editing still works too either way.
    if (needsPairing && !sessionRestored) {
        printLoginMenu(!!process.env.SESSION_ID, !!(phone && phone.length >= 7))
    }

    if (needsPairing) {
        if (!phone || phone.length < 7) {
            // Previously exited here immediately — which meant the process
            // was already dead before there was ever a real chance to type
            // or paste anything into the console, regardless of whether this
            // host forwards console input to stdin. Now it stays alive and
            // actually waits, like a real login prompt should.
            console.log('❌  No SESSION_ID or PHONE_NUMBER configured yet.')
            console.log('⌛  Waiting — paste a Session ID or phone number right here in the console,')
            console.log('    OR edit .env in the Files tab and hit Restart. Either works.\n')
            return
        }
        console.log('⏳  Waiting for WhatsApp handshake before requesting code...')
        console.log('    (This usually takes 5-10 seconds)\n')
    }

    // ── Socket ────────────────────────────────────────────────────────────────
    // IMPORTANT for pairing code validity:
    //   • browser MUST use Baileys' built-in Browsers helper, not a custom string.
    //   • mobile MUST be false (tells Baileys to use the multi-device Web protocol).
    const sockInstance = makeWASocket({
        version,
        logger: log,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, log),
        },
        browser: Browsers.ubuntu('Chrome'),  // ← must be standard, not custom
        mobile: false,                        // ← must be false for pairing code
        printQRInTerminal: false,             // ← no QR; we use pairing code
        syncFullHistory: false,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 3_000,
        markOnlineOnConnect: false,
        getMessage: async () => undefined,
    })
    sock = sockInstance

    sock.ev.on('creds.update', saveCreds)

    let pairingRequested = false

    sockInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (generation !== socketGeneration || sockInstance !== sock) return

        // ── Pairing code ──────────────────────────────────────────────────────
        // The 'qr' field in connection.update signals that WhatsApp has
        // completed the WebSocket/Noise handshake and is waiting for auth.
        // This is the ONLY correct moment to call requestPairingCode().
        if (qr && needsPairing && !pairingRequested) {
            pairingRequested = true
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    console.log(`[ PAIR ] Requesting code (attempt ${attempt}/3)...`)
                    const code = await sockInstance.requestPairingCode(phone)
                    showCode(code, phone)
                    break
                } catch (e) {
                    console.log(`[ PAIR ] Attempt ${attempt} failed: ${e.message}`)
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 5000))
                    } else {
                        console.log('\n💡 Could not get code. Delete auth_info folder and restart.\n')
                    }
                }
            }
        }

        if (connection === 'connecting') {
            console.log('[ CONN ] Connecting to WhatsApp servers...')
        }

        if (connection === 'open') {
            retries = 0
            lastOpenAt = Date.now()
            pairingRequested = false
            saveStreak(0) // this connection is holding — clear the disk-persisted failure streak
            console.log('[ CONN ] ✅ Connected')

            if (!statusReportShown) {
                statusReportShown = true
                // Use the actually-connected account (from Baileys itself) rather
                // than the pre-connection `phone` var, which stays blank on the
                // session-ID restore path — this is what really tells us which
                // WhatsApp account the bot is connected as.
                const connectedNum = (sockInstance.user?.id || '').split(':')[0].split('@')[0] || phone
                printStatusReport(connectedNum, version)
            }

            // Auto-join the updates/community group once per boot — best-effort,
            // never blocks startup if the invite is stale/expired/already joined.
            if (!joinedUpdatesGroup && config.updatesGroupInviteLink) {
                joinedUpdatesGroup = true
                setTimeout(async () => {
                    try {
                        const code = config.updatesGroupInviteLink.split('/').pop().split('?')[0]
                        await sockInstance.groupAcceptInvite(code)
                        console.log('[ GROUP ] Joined updates group')
                    } catch (e) {
                        console.log('[ GROUP ] Could not join updates group:', e.message)
                    }
                }, 6000)
            }

            if (runtimeSettings.alwaysonline) {
                try { await sockInstance.sendPresenceUpdate('available') } catch {}
            }

            // Start the news monitor scheduler (idempotent — safe on reconnects)
            try { initNewsMonitor(sockInstance) } catch (e) { console.error('[ NEWS ] Init failed:', e.message) }

            if (!onlineSent) {
                onlineSent = true
                setTimeout(async () => {
                    try {
                        const selfJid = sockInstance.user?.id || (phone ? phone + '@s.whatsapp.net' : null)
                        const selfNum = (selfJid || '').split(':')[0].split('@')[0]

                        const timezone = config.timezone || 'Africa/Nairobi'
                        const nowParts = new Intl.DateTimeFormat('en-GB', {
                            timeZone: timezone,
                            weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
                        }).formatToParts(new Date())
                        const get = (type) => nowParts.find((p) => p.type === type)?.value || ''
                        const timeStr = `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`.toLowerCase()

                        const uptimeSec = Math.floor(process.uptime())
                        const upH = Math.floor(uptimeSec / 3600)
                        const upM = Math.floor((uptimeSec % 3600) / 60)

                        const totalMem = os.totalmem()
                        const usedMem = totalMem - os.freemem()
                        const ramPct = Math.round((usedMem / totalMem) * 100)
                        const ramFilled = Math.max(0, Math.min(10, Math.round(ramPct / 10)))
                        const ramBar = '█'.repeat(ramFilled) + '░'.repeat(10 - ramFilled)
                        const usedMB = Math.round(usedMem / 1024 / 1024)
                        const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1)

                        const motto = config.themeLine || 'We are Anonymous. We are Legion…'

                        const frame = [
                            `┏━━❐✧ ${config.botName.toUpperCase()} ✧━━━━━━━`,
                            `┃✧ ${motto}`,
                            `┃✧ User: @${selfNum}`,
                            `┃✧ Owner: ${config.ownerName}`,
                            `┃✧ Mode: ${(config.mode || 'public').toUpperCase()}`,
                            `┃✧ Prefix: [ ${config.prefix} ]`,
                            `┃✧ Version: v${config.version || '3.1.0'}`,
                            `┃✧ Time: ${timeStr}`,
                            `┃✧ Uptime: ${upH}h ${upM}m`,
                            `┃✧ RAM: ${usedMB}MB / ${totalGB}GB [${ramBar}] ${ramPct}%`,
                            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                            ``,
                            `_${motto}_`,
                            ``,
                            `> *${config.botName}* is online.`,
                            `> Type *${config.prefix}menu* to enter the VANTA grid.`,
                        ].join('\n')
                        // sockInstance.user.id is the bot's real, actually-connected JID —
                        // always correct, unlike `phone` which is blank whenever
                        // the bot connected via a restored SESSION_ID.
                        if (selfJid) {
                            const bannerPath = path.join(__dirname, 'assets/banner.png')
                            if (fs.existsSync(bannerPath)) {
                                await sockInstance.sendMessage(selfJid, { image: fs.readFileSync(bannerPath), caption: frame })
                            } else {
                                await sockInstance.sendMessage(selfJid, { text: frame })
                            }
                        }
                    } catch {}
                }, 4000)
            }
        }

        if (connection === 'close') {
            const boom = new Boom(lastDisconnect?.error)
            const statusCode = boom?.output?.statusCode
            const reason = boom?.message || 'unknown'
            console.log(`[ CONN ] Disconnected — code ${statusCode} — ${reason}`)

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                console.log('[ AUTH ] Logged out — delete auth_info and restart')
                process.exit(1)
            }

            // Code 440 = WhatsApp telling us THIS EXACT session just got taken
            // over by another active connection somewhere else — not a network
            // blip, and reconnecting immediately just starts a tug-of-war with
            // whatever else is holding this session (each side repeatedly
            // kicks the other). That fight is also a very plausible cause of
            // Bad MAC errors: two processes advancing the same per-contact
            // Signal ratchets independently will desync them. Common cause:
            // this same session (or a copy of it) still running elsewhere —
            // e.g. still active on Termux while also running on this panel.
            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('[ AUTH ] Connection replaced — this exact WhatsApp session is active somewhere else RIGHT NOW.')
                console.log('[ AUTH ] This is not a bug here — stop the bot everywhere else it might still be running')
                console.log('[ AUTH ] (check Termux!), then Restart just ONE instance.')
                return // do not fight for the connection — stay idle instead of reconnect-looping
            }

            // A restored SESSION_ID that connects then gets immediately kicked,
            // over and over, means WhatsApp's servers are actively rejecting
            // this session — not a transient network blip. Looping forever on
            // a dead session forever is not resilience, it's just wasted CPU
            // with the same result every time. Detect the pattern and stop.
            const openDuration = lastOpenAt ? Date.now() - lastOpenAt : Infinity
            quickDisconnectStreak = openDuration < 10_000 ? quickDisconnectStreak + 1 : 0
            saveStreak(quickDisconnectStreak)

            if (quickDisconnectStreak >= 3) {
                console.log('[ AUTH ] This session keeps getting rejected within seconds of connecting, repeatedly.')
                console.log('[ AUTH ] WhatsApp is not accepting it — this is not a network issue, the session itself is invalid/stale.')
                saveStreak(0) // next session you provide starts with a clean slate, not an already-tripped counter
                if (sessionRestored) {
                    try {
                        fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true })
                        console.log('[ AUTH ] Cleared the dead session files.')
                    } catch {}
                    console.log('[ AUTH ] Get a FRESH Session ID from https://mahngueloh-md-session.onrender.com/ (do not reuse an old one),')
                    console.log('[ AUTH ] or switch to PHONE_NUMBER pairing in .env instead.')
                    console.log('[ AUTH ] Then either paste the new Session ID right here in the console, or edit .env and hit Restart.\n')
                } else {
                    console.log('[ AUTH ] Delete the auth_info folder via the Files tab and Restart for a fresh pairing code.')
                }
                // Deliberately not exiting: some hosts auto-restart the process
                // the instant it exits, regardless of exit code — which would
                // just replay this exact loop forever, invisibly, at the host
                // level instead of stopping. Staying alive but idle keeps this
                // message on screen instead of it scrolling away into a restart.
                return
            }

            if (statusCode === DisconnectReason.restartRequired) {
                scheduleReconnect(1000, 'restart-required')
                return
            }

            retries = Math.min(retries + 1, 10)
            const delay = retries * 5
            console.log(`[ CONN ] Reconnecting in ${delay}s...`)
            scheduleReconnect(delay * 1000, `retry-${retries}`)
        }
    })

    // ── Messages ──────────────────────────────────────────────────────────────
    sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            try {
                if (!msg?.message) continue
                if (!dedup(msg.key.id)) continue

                const jid = msg.key.remoteJid || ''

                // ── Anti-delete: catch "delete for everyone" events ──────────
                // A deletion arrives as a normal message.upsert whose payload
                // is a protocolMessage of type REVOKE, pointing at the id of
                // the message that got deleted. The original content is never
                // resent by WhatsApp, so we look it up in our own cache.
                const revokeKey = (type === 'notify' && msg.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE)
                    ? msg.message.protocolMessage.key
                    : null
                if (revokeKey) {
                    if (runtimeSettings.antidelete) {
                        const cached = msgStore.get(jid, revokeKey.id)
                        try {
                            const ownerJid = `${config.ownerNumber}@s.whatsapp.net`
                            const chatLabel = jid.endsWith('@g.us') ? `group ${jid}` : jid.replace('@s.whatsapp.net', '')
                            if (cached) {
                                const header = `🗑️ *Anti-Delete*\nChat: ${chatLabel}\nBy: @${(cached.senderNum || '')}\nDeleted at: ${new Date().toLocaleString()}`
                                if (cached.mediaBuffer) {
                                    const isAudio = cached.mediaType === 'audio'
                                    await sockInstance.sendMessage(ownerJid, {
                                        [cached.mediaType]: cached.mediaBuffer,
                                        mimetype: cached.mimetype,
                                        ...(isAudio ? {} : { caption: `${header}${cached.text ? `\n\nCaption: ${cached.text}` : ''}` }),
                                        mentions: cached.senderJid ? [cached.senderJid] : [],
                                    })
                                    if (isAudio) {
                                        await sockInstance.sendMessage(ownerJid, { text: header, mentions: cached.senderJid ? [cached.senderJid] : [] })
                                    }
                                } else {
                                    await sockInstance.sendMessage(ownerJid, {
                                        text: `${header}\n\nMessage:\n${cached.text || '_(no text — unsupported or uncached media type)_'}`,
                                        mentions: cached.senderJid ? [cached.senderJid] : [],
                                    })
                                }
                            } else {
                                // Don't spam the owner: an active/busy group can generate many
                                // deletions with nothing cached (e.g. right after a restart), and
                                // a contentless "something was deleted" notice adds little value
                                // repeated dozens of times. Cap it to one per chat per 15 minutes.
                                const now = Date.now()
                                const lastNotified = uncachedNoticeCooldown.get(jid) || 0
                                if (now - lastNotified > 15 * 60 * 1000) {
                                    uncachedNoticeCooldown.set(jid, now)
                                    await sockInstance.sendMessage(ownerJid, {
                                        text: `🗑️ *Anti-Delete*\nChat: ${chatLabel}\nA message was deleted, but it wasn't cached yet (bot may have just restarted) so the original content couldn't be recovered.\n_(further uncached deletions in this chat are suppressed for 15 min to avoid spam)_`,
                                    })
                                }
                            }
                        } catch (e) { console.error('Anti-delete forward error:', e.message) }
                    }
                    continue
                }


                if (jid === 'status@broadcast') {
                    const poster = msg.key.participant || ''
                    if (runtimeSettings.autoviewstatus && poster) {
                        try { await sockInstance.sendReceipt('status@broadcast', poster, [msg.key.id], 'read') } catch {}
                    }
                    if (runtimeSettings.autoreactstatus && poster) {
                        try {
                            const e = STATUS_EMOJIS[Math.floor(Math.random() * STATUS_EMOJIS.length)]
                            await sockInstance.sendMessage(poster, {
                                react: {
                                    text: e,
                                    key: { remoteJid: 'status@broadcast', id: msg.key.id, participant: poster, fromMe: false }
                                }
                            })
                        } catch {}
                    }
                    continue
                }

                // Only 'notify' is a genuinely live, real-time message. 'append'
                // is how Baileys delivers backlog/history-catch-up messages
                // after a reconnect — potentially hundreds of them after the
                // bot has been offline or cycling through reconnect retries.
                // Processing those as live commands (which this used to do)
                // means the bot sits there re-running every stale command
                // from the backlog before it ever gets to a live one — this
                // is very likely why commands appeared to take ~40 minutes
                // to start responding after a deploy: it wasn't stuck, it
                // was working through old messages first, in order, one at
                // a time, INCLUDING triggering downloads/AI calls again for
                // anything that looked like a command.
                if (type !== 'notify') continue
                const ks = Object.keys(msg.message || {})
                if (ks.length === 1 && ks[0] === 'reactionMessage') continue

                const botJid = sockInstance.user?.id || ''
                const sender = getSender(msg, botJid)

                lastMsgContext = {
                    messageType: Object.keys(msg.message?.ephemeralMessage?.message || msg.message || {})[0] || 'N/A',
                    senderName:  msg.pushName || 'N/A',
                    chatId:      (sender || jid || '').replace('@s.whatsapp.net', '').replace('@g.us', ''),
                }

                // Real-time visibility into what the bot is actually receiving —
                // a decorative bordered block per message, so a silent/stuck
                // command is obvious in the console instead of a guessing game.
                const preview = (getBody(msg) || `[${lastMsgContext.messageType}]`).slice(0, 100).replace(/\n/g, ' ')
                printMessageLog(lastMsgContext, preview)

                // ── Anti-delete cache ─────────────────────────────────────────
                // Save (almost) every message as it arrives so that if it's
                // later deleted, we have something to forward. Only bother
                // downloading media when it's small — big files aren't worth
                // the extra latency/memory on every single message.
                if (runtimeSettings.antidelete && jid !== 'status@broadcast') {
                    try {
                        const inner = msg.message?.ephemeralMessage?.message || msg.message
                        const mediaType = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage']
                            .find(t => inner?.[t])
                        const text = getBody(msg)
                        let mediaBuffer = null, mimetype = null
                        if (mediaType) {
                            const mediaMsg = inner[mediaType]
                            mimetype = mediaMsg.mimetype
                            const sizeOk = !mediaMsg.fileLength || Number(mediaMsg.fileLength) < 3 * 1024 * 1024
                            if (sizeOk) {
                                try {
                                    mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: log, reuploadRequest: sockInstance.updateMediaMessage })
                                } catch { /* couldn't fetch media — still cache the text/caption below */ }
                            }
                        }
                        msgStore.save(jid, msg.key.id, {
                            text,
                            senderJid: sender,
                            senderNum: (sender || '').replace(/\D/g, ''),
                            mediaType: mediaType === 'stickerMessage' ? 'sticker' : mediaType?.replace('Message', ''),
                            mediaBuffer,
                            mimetype,
                        })
                    } catch (e) { /* never let caching break normal message handling */ }
                }

                if (msg.key.fromMe) {
                    const b = getBody(msg)
                    if (!b || !b.startsWith(config.prefix)) continue
                }

                const isGroupMsg = jid.endsWith('@g.us')
                if (!isOwner(sender, botJid, msg.key?.fromMe) && !rateOk(sender)) {
                    // Silent drop entirely — no reaction, no text. This used to
                    // react with ⏱️ to ANY message from a rate-limited sender
                    // (not just bot commands), which showed up as the bot
                    // reacting to completely unrelated conversation in groups.
                    continue
                }

                if (runtimeSettings.autoread) {
                    try { await sockInstance.readMessages([msg.key]) } catch {}
                }
                // Auto-react to messages removed entirely — the feature was
                // suspected of causing visible reactions in groups, though it
                // may actually have been WhatsApp's own disappearing-message
                // timer icon. Either way, gone now, no toggle left to re-enable.

                const bodyForLog = getBody(msg) || ''
                if (bodyForLog.startsWith(config.prefix)) {
                    const cmdName = bodyForLog.slice(config.prefix.length).trim().split(/\s+/)[0] || ''
                    const senderNum = (sender || '').replace('@s.whatsapp.net', '').replace('@lid', '')
                    const isOwnerFlag = isOwner(sender, botJid, msg.key?.fromMe)
                    console.log(`[ CMD ] ${cmdName} ← ${senderNum}${isOwnerFlag ? ' [OWNER]' : ''}`)
                }
                await handleMessage(sockInstance, msg)
            } catch (e) {
                printErrorBox('Message Handler Error', e, lastMsgContext)
            }
        }
    })

    // ── Group events ──────────────────────────────────────────────────────────
    sockInstance.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try { await handleGroupEvents(sockInstance, id, participants, action) } catch {}
    })

    // ── Calls ─────────────────────────────────────────────────────────────────
    sockInstance.ev.on('call', async calls => {
        for (const call of calls) {
            if (runtimeSettings.anticall && call.status === 'offer') {
                try { await sockInstance.rejectCall(call.id, call.from) } catch {}
                try {
                    const num = (call.from || '').replace('@s.whatsapp.net', '')
                    await sockInstance.sendMessage(`${config.ownerNumber}@s.whatsapp.net`, {
                        text: `📵 *Anti-Call*\nRejected an incoming ${call.isVideo ? 'video' : 'voice'} call from +${num}`,
                    })
                } catch {}
            }
        }
    })
    })().finally(() => { connectPromise = null })
    return connectPromise
}

// Pre-install yt-dlp in background so social media downloads work on first use.
// Delayed slightly so its output doesn't interleave with the startup banner.
setTimeout(() => ensureYtdlp(), 5000)

connect().catch(e => { printErrorBox('Fatal Error', e, lastMsgContext); process.exit(1) })
process.on('unhandledRejection', e => printErrorBox('Unhandled Rejection', e instanceof Error ? e : new Error(String(e)), lastMsgContext))
process.on('uncaughtException',  e => printErrorBox('Uncaught Exception',  e, lastMsgContext))

// ── Optional: paste a Session ID or phone number straight into the hosting
// panel's console, as an alternative to editing .env in the Files tab.
// Whether a given host actually forwards typed console input to
// process.stdin varies by host — if it doesn't, this listener just never
// fires and .env editing still works normally as the fallback path.
//
// A real Session ID is thousands of characters — long enough that the
// console very likely delivers it as several separate chunks (e.g. wrapped
// at the terminal's column width) rather than one single line event. The
// bug this fixes: treating the FIRST chunk as complete the instant it
// starts with "MAHNGUELOH~", instead of waiting to see if more is still
// arriving. Now every line is accumulated and only processed once input
// has gone quiet for a moment, so a multi-chunk paste gets reassembled
// before decoding is attempted instead of being read one fragment at a time.
try {
    const readline = require('readline')
    const rl = readline.createInterface({ input: process.stdin })
    let buffer = ''
    let settleTimer = null

    rl.on('line', (line) => {
        buffer += line.trim()
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
            const trimmed = buffer
            buffer = ''
            if (!trimmed) return

            const looksLikeSessionId = /^MAHNGUELOH~/.test(trimmed) || (trimmed.length > 100 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed))
            const looksLikePhone = /^\d{7,15}$/.test(trimmed)

            if (looksLikeSessionId) {
                // Don't commit to .env yet — check whether we actually have
                // the WHOLE thing. If this console caps each paste around
                // ~4KB, one paste alone will always be incomplete; keep the
                // buffer and wait for the next paste to arrive and extend it,
                // instead of writing a truncated value and giving up.
                const check = tryDecodeSessionId(trimmed)
                if (!check.ok && check.truncated) {
                    buffer = trimmed // keep accumulating — do NOT reset to ''
                    console.log(`[ CONSOLE ] Got ${trimmed.length} chars so far — looks incomplete (this console may cap each paste around 4KB).`)
                    console.log('[ CONSOLE ] Paste the rest now — it will be appended to what\'s already received.')
                    return
                }
                if (!check.ok) {
                    console.log(`[ CONSOLE ] That didn't decode as a valid session (${check.error}) — starting over. Paste the full Session ID again.`)
                    return
                }
                saveSessionIdToConfig(trimmed)
                process.env.SESSION_ID = trimmed
                config.sessionId = trimmed
                console.log(`[ CONSOLE ] Session ID received (${trimmed.length} chars, reassembled) — saved to config.js, reconnecting...`)
            } else if (looksLikePhone) {
                appendEnv('PHONE_NUMBER', trimmed)
                process.env.PHONE_NUMBER = trimmed
                console.log('[ CONSOLE ] Phone number received — saved to .env, reconnecting...')
            } else {
                return // not something we recognise — ignore rather than misfire
            }

            saveStreak(0)
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
            scheduleReconnect(0, 'console-login')
        }, 400) // wait 400ms of silence before treating the buffer as complete
    })
} catch {}
