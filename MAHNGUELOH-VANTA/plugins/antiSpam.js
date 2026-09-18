const { isAdmin } = require('../lib/utils')
const { getSettings } = require('./groupSettings')
const fmt = require('../lib/format')

const LINK_REGEX = /(?:https?:\/\/|www\.|chat\.whatsapp\.com|t\.me|bit\.ly|youtu\.be)\S+/i
const SPAM_LIMIT  = 5
const SPAM_WINDOW = 5000

// ── Known WhatsApp "crash bug" message signatures ──────────────────────────
// These are the recurring families of malformed/malicious messages used to
// freeze or crash a recipient's WhatsApp — zero-width character floods,
// bidirectional-override abuse, malformed vCard payloads, absurdly long
// single messages, runs of combining marks, and scripts from a few ranges
// that some WA client versions render pathologically slowly in bulk.
const BUG_PATTERNS = [
    /waiting for this msg/i,                          // known "waiting" bug placeholder text
    /vnd\.android\.cursor\.item\/vcard/i,              // malformed vCard/contact-card payload
    // Zero-width/invisible characters are only a bug signal in bulk — a
    // single ZWJ (\u200D) is completely normal, it's what composes family
    // emoji (👨‍👩‍👧‍👦), flag emoji (🏳️‍🌈), and gendered/profession emoji.
    // Only a flood of dozens+ in a row is an actual crash payload.
    /(\u200B|\u200C|\u200D|\u2060|\uFEFF){30,}/,        // zero-width character flood
    /.{3000,}/,                                          // absurdly long single message
    /([\uD800-\uDBFF][\uDC00-\uDFFF]){50,}/,            // surrogate-pair (emoji) flood
    /(\uFFFD){20,}/,                                     // replacement-character flood
    /(\u034F){10,}/,                                     // combining grapheme joiner flood
    /https?:\/\/\S{500,}/,                               // absurdly long URL
    /(\u202E|\u202D)/,                                   // right-to-left / left-to-right override
    /(\u00AD){10,}/,                                     // soft-hyphen flood
    /(\u25A0|\u25A1){30,}/,                              // box-glyph flood
    /(\u2800){10,}/,                                     // braille blank-pattern flood
    /(\uA9BE|\uA9BF|\uA9BD|\uA9C0){3,}/,                // Javanese combining-mark abuse
    /[\u0E00-\u0E7F]{30,}/,                              // Thai block flood (rendering-cost abuse)
    /[\u1000-\u109F]{30,}/,                              // Myanmar block flood
    /[\uA980-\uA9DF]{30,}/,                              // Javanese block flood
    /[\u1B00-\u1B7F]{30,}/,                              // Balinese block flood
    /[\uFE10-\uFE1F]{10,}/,                              // vertical-forms flood
]

const warnCounts = new Map()
const WARN_MAX   = 3

// ── Generic action helper ─────────────────────────────────────────────────────
async function applyAction(sock, msg, from, sender, action, reason) {
    const key   = `${from}_${sender}`
    const warns = (warnCounts.get(key) || 0) + 1
    const userNum = sender.split('@')[0]

    // Always delete the offending message first
    try { await sock.sendMessage(from, { delete: msg.key }) } catch {}

    if (action === 'warn') {
        warnCounts.set(key, warns)
        const reachedMax = warns >= WARN_MAX
        if (reachedMax) {
            warnCounts.delete(key)
            try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        }
        await sock.sendMessage(from, {
            text: fmt.warnCard(userNum, warns, WARN_MAX, reason),
            mentions: [sender]
        })
    } else if (action === 'delete') {
        await sock.sendMessage(from, {
            text: fmt.box('MESSAGE DELETED', [
                `🗑️ @${userNum} — message removed`,
                `📌 *Reason:* ${reason}`,
            ]),
            mentions: [sender]
        })
    } else if (action === 'kick') {
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.kickCard(userNum, reason),
            mentions: [sender]
        })
    }
}

// ── Anti-link ─────────────────────────────────────────────────────────────────
async function antiLinkCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antilink) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || ''
    if (!LINK_REGEX.test(body)) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antilinkAction || 'warn', 'Links are not allowed in this group')
    return true
}

// ── Anti-spam ─────────────────────────────────────────────────────────────────
async function antiSpamCheck(sock, msg, from, sender, spamMap) {
    const s = getSettings(from)
    if (!s.antispam) return false
    if (await isAdmin(sock, from, sender)) return false
    const key   = `${from}_${sender}`
    const now   = Date.now()
    const entry = spamMap.get(key) || { count: 0, first: now }
    if (now - entry.first > SPAM_WINDOW) { spamMap.set(key, { count: 1, first: now }); return false }
    entry.count++
    spamMap.set(key, entry)
    if (entry.count >= SPAM_LIMIT) {
        spamMap.delete(key)
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.kickCard(sender.split('@')[0], 'Spamming too many messages'),
            mentions: [sender]
        })
        return true
    }
    return false
}

// ── Anti-sticker ──────────────────────────────────────────────────────────────
async function antiStickerCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antisticker || !msg.message?.stickerMessage) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antistickerAction || 'delete', 'Stickers are not allowed here')
    return true
}

// ── Anti-voice note ───────────────────────────────────────────────────────────
async function antiVoiceNoteCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antivoicenote || msg.message?.audioMessage?.ptt !== true) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antivoicenoteAction || 'delete', 'Voice notes are not allowed here')
    return true
}

const bugStrikes = new Map()
const DM_STRIKE_LIMIT    = 3   // DM: blocked after this many bug messages
const GROUP_STRIKE_LIMIT = 4   // Group: kicked after this many bug messages
const EMOJI_SPAM_LIMIT   = 100
const MENTION_SPAM_LIMIT = 20
const LENGTH_SPAM_LIMIT  = 5000
const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu

// Runs every detection vector over one message and reports what tripped.
function detectBugMessage(msg, body) {
    if (body.length > LENGTH_SPAM_LIMIT) return 'Long text spam'
    const emojiCount = (body.match(EMOJI_REGEX) || []).length
    if (emojiCount > EMOJI_SPAM_LIMIT) return 'Emoji spam'
    const mentionCount = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0
    if (mentionCount > MENTION_SPAM_LIMIT) return 'Mention spam'
    if (BUG_PATTERNS.some(p => p.test(body))) return 'Malformed/crash payload'
    return null
}

// Shared strike bookkeeping for both the group and DM checks below —
// delete the message, bump the sender's strike count, and report back
// whether the limit was reached so the caller can kick/block.
async function recordBugStrike(sock, msg, from, sender) {
    try { await sock.sendMessage(from, { delete: msg.key }) } catch {}
    const strikes = (bugStrikes.get(sender) || 0) + 1
    bugStrikes.set(sender, strikes)
    return strikes
}

// ── Anti-bug (groups) ───────────────────────────────────────────────────────
async function antiBugCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antibug) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const bugType = detectBugMessage(msg, body)
    if (!bugType) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false

    const num = sender.split('@')[0]
    const strikes = await recordBugStrike(sock, msg, from, sender)

    if (strikes >= GROUP_STRIKE_LIMIT) {
        bugStrikes.delete(sender)
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.box('MAHNGUELOH VANTA — ANTIBUG', [
                `🚫 @${num} removed — bug message (${bugType})`,
                `Strike ${strikes}/${GROUP_STRIKE_LIMIT}`,
            ]),
            mentions: [sender]
        })
    } else {
        await sock.sendMessage(from, {
            text: fmt.box('MAHNGUELOH VANTA — ANTIBUG', [
                `⚠️ @${num} — message deleted (${bugType})`,
                `Strike ${strikes}/${GROUP_STRIKE_LIMIT} — removed at ${GROUP_STRIKE_LIMIT}`,
            ]),
            mentions: [sender]
        })
    }
    return true
}

// ── Anti-bug (DMs — protects the owner's own inbox) ─────────────────────────
// Gated by the owner-level runtimeSettings.antibug toggle (`.antibug`), not
// group settings — this runs on the bot's private chats. A lower strike
// limit than groups: there's no "community" to weigh here, just the
// owner's own number, so it blocks sooner.
async function antiBugCheckDM(sock, msg, from, sender, ownerIsUser, enabled) {
    if (!enabled || ownerIsUser) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const bugType = detectBugMessage(msg, body)
    if (!bugType) return false

    const strikes = await recordBugStrike(sock, msg, from, sender)

    if (strikes >= DM_STRIKE_LIMIT) {
        bugStrikes.delete(sender)
        try { await sock.updateBlockStatus(sender, 'block') } catch {}
        console.log(`[ANTIBUG] Blocked ${sender} — bug message (${bugType}), strike ${strikes}/${DM_STRIKE_LIMIT}`)
    } else {
        await sock.sendMessage(from, {
            text: fmt.box('MAHNGUELOH VANTA — ANTIBUG', [
                `⚠️ Message deleted (${bugType})`,
                `Strike ${strikes}/${DM_STRIKE_LIMIT} — blocked at ${DM_STRIKE_LIMIT}`,
            ])
        })
    }
    return true
}

// ── Anti-group-mention ────────────────────────────────────────────────────────
async function antiGroupMentionCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antigroupmention) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const hasGroupMention =
        /@(everyone|all|here|group)/i.test(body) ||
        (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0) > 5
    if (!hasGroupMention) return false
    if ((await isAdmin(sock, from, sender)) || ownerIsUser) return false
    await applyAction(sock, msg, from, sender, s.antigroupmentionAction || 'delete', 'Mass group mentions are not allowed')
    return true
}

// ── Anti-bot ───────────────────────────────────────────────────────────────
// Content-based detection (matching specific decorative characters) is a
// losing game — every bot picks its own bullet style (box-drawing, arrows,
// dots, dashes, emoji...) and a fixed glyph list only ever covers the ones
// already seen. So this covers two signals that don't depend on WHICH
// characters a bot happens to use:
//
//   1. BEHAVIOR — a non-admin sends something command-shaped (any short
//      symbol prefix + a word: ".menu", "!help", "↠play", whatever) that
//      isn't addressed to OUR prefix. That's remembered per group for a
//      short window. If a reply then arrives — from anyone, since the
//      "bot" account triggered often isn't a group admin either — that
//      looks like automated multi-line output, it's attributed to that
//      trigger and flagged, regardless of what it's decorated with.
//   2. STRUCTURE, not decoration — a real menu/status dump reliably has
//      several lines that each start with SOMETHING that isn't a letter
//      (a bullet, an arrow, a box character, a dash, an emoji — the
//      specific symbol never matters, only that line after line opens
//      with a non-word character). Counting lines shaped that way,
//      combined with common status wording, catches "↠ .command" just as
//      well as "┃ Owner: ..." or "│ owner: ..." without listing glyphs.
const BOT_WORDING_PATTERN = /\b(menu|commands?|prefix|owner|uptime|runtime|version|platform|speed|usage|powered\s*by|repo)\b/i
const BULLET_LINE_PATTERN = /^\s*[^a-zA-Z0-9\s]/u   // line's first visible char isn't alphanumeric
const MIN_BULLET_LINES = 5

function countBulletLines(body) {
    return body.split('\n').filter(l => l.trim() && BULLET_LINE_PATTERN.test(l)).length
}

function looksLikeBotOutput(body) {
    if (!body) return false
    const bulletLines = countBulletLines(body)
    // Strong on its own: a real menu-length dump of bulleted lines.
    if (bulletLines >= MIN_BULLET_LINES && BOT_WORDING_PATTERN.test(body)) return true
    return false
}

// Looser structural check used only when we already have a recent trigger
// to attribute this message to — a shorter/weaker signal is fine here
// because the context (this is a reply right after someone commanded
// something) is already doing most of the work.
function looksLikeAutomatedReply(body) {
    if (!body) return false
    const bulletLines = countBulletLines(body)
    return bulletLines >= 2 || BOT_WORDING_PATTERN.test(body)
}

const FOREIGN_PREFIX_PATTERN = /^[^\w\s][a-zA-Z]/u   // any short symbol/emoji + a letter — not just a fixed set

function looksLikeForeignBotCommand(body, ownPrefix) {
    const trimmed = (body || '').trim()
    if (!trimmed || !FOREIGN_PREFIX_PATTERN.test(trimmed)) return false
    // Starts with this bot's own prefix → it's a normal command for us,
    // never flag it (this is what makes it safe to run for every message,
    // not just non-commands).
    if (ownPrefix && trimmed.startsWith(ownPrefix)) return false
    return true
}

// Per-group memory of "someone just sent something command-shaped" so a
// suspicious reply that follows shortly after can be attributed to it.
// Bounded and self-cleaning: one entry per group, overwritten on the next
// trigger, expired by TRIGGER_WINDOW_MS on read.
const pendingTriggers = new Map()   // groupJid -> { sender, at }
const TRIGGER_WINDOW_MS = 20_000

function markPossibleTrigger(groupJid, body, ownPrefix) {
    const trimmed = (body || '').trim()
    const isCommandShaped = FOREIGN_PREFIX_PATTERN.test(trimmed) || (ownPrefix && trimmed.startsWith(ownPrefix))
    const isBareTriggerWord = /^(menu|help|start|hi|hello)$/i.test(trimmed)
    if (isCommandShaped || isBareTriggerWord) {
        pendingTriggers.set(groupJid, { at: Date.now() })
    }
}

function hasRecentTrigger(groupJid) {
    const t = pendingTriggers.get(groupJid)
    if (!t) return false
    if (Date.now() - t.at > TRIGGER_WINDOW_MS) { pendingTriggers.delete(groupJid); return false }
    return true
}

async function antiBotCheck(sock, msg, from, sender, ownerIsUser, ownPrefix) {
    const s = getSettings(from)
    if (!s.antibot) return false
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''

    const looksCommanded = looksLikeForeignBotCommand(body, ownPrefix)
    const isAdminSender = (await isAdmin(sock, from, sender)) || ownerIsUser

    // Any command-shaped message (or bare "menu"/"help") primes the trigger
    // window, regardless of sender — even the owner's own .menu can prompt
    // a coincidentally-listening foreign bot to answer, and it's that
    // answer we actually care about catching.
    markPossibleTrigger(from, body, ownPrefix)

    const looksAutomated = looksLikeBotOutput(body) || (hasRecentTrigger(from) && looksLikeAutomatedReply(body))
    if (!looksCommanded && !looksAutomated) return false
    if (isAdminSender) return false

    await applyAction(
        sock, msg, from, sender, s.antibotAction || 'warn',
        looksCommanded ? 'Commanding another bot is not allowed here' : 'Looked like automated bot output'
    )
    pendingTriggers.delete(from)
    return true
}

module.exports = { antiLinkCheck, antiSpamCheck, antiStickerCheck, antiVoiceNoteCheck, antiBugCheck, antiBugCheckDM, antiGroupMentionCheck, antiBotCheck }
