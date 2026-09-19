'use strict'

const config = require('../config')
const os = require('os')
const fs = require('fs')
const path = require('path')
const fmt = require('../lib/format')

// VANTA-style read-more padding.
// Kept intentionally smaller than the example's 2001 repeats so the menu
// stays WhatsApp-friendly even with a large command library.
const more = String.fromCharCode(8206)
const readMore = more.repeat(600)

function getRam() {
    const total = os.totalmem()
    const used = total - os.freemem()
    const pct = Math.round((used / total) * 100)
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)))
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
    return {
        pct,
        usedMB: Math.round(used / 1024 / 1024),
        totalGB: (total / 1024 / 1024 / 1024).toFixed(1),
        bar,
    }
}

function getNow() {
    const timezone = config.timezone || 'Africa/Nairobi'
    const now = new Date()

    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    }).formatToParts(now)

    const get = (type) => parts.find((p) => p.type === type)?.value || ''
    const date = `${get('day')}-${get('month').toUpperCase()}-${get('year')}`
    const time = `${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod')}`
    return { date, time, timezone }
}

function getUptime() {
    const total = Math.floor(process.uptime())
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    return `${hours}h ${minutes}m ${seconds}s`
}

// Corner glyphs used by the VANTA box style throughout the menu.
const DECO = '•⩵꙰ཱི࿐'
const TOP    = (label) => `╭═━⪩ 〖 ${label} 〗═══━${DECO}`
const BOTTOM = `╰━ ━ ━ ━ ━ ━ ━ ━ ━${DECO}`

function box(title, commands) {
    const rows = commands.map((c) => `│❍ ${c}`).join('\n')
    return `${TOP(title)}\n${rows}\n${BOTTOM}`
}

function statusBox(commandCount, menuCount) {
    const ram = getRam()
    const now = getNow()
    const mode = String(config.mode || 'public').toUpperCase()
    const owner = config.ownerName || 'MAHNGUELOH'
    const version = config.version || '3.1.0'
    const botName = (config.botName || 'MAHNGUELOH VANTA').toUpperCase()

    return `•━═ 〘 ${botName} 〙═━•

╭═━⪩ 〘 VANTA STATUS 〙•━${DECO}
│⫹⫺ Protocol: ANONYMOUS • VANTA 🟢
│⫹⫺ Owner: ${owner}
│⫹⫺ Mode: ${mode}
│⫹⫺ Prefix: [ ${config.prefix} ]
│⫹⫺ Version: v${version}
│⫹⫺ Commands: ${commandCount} loaded
│⫹⫺ Categories: ${menuCount} core modules
│⫹⫺ Uptime: ${getUptime()}
│⫹⫺ Date: ${now.date}
│⫹⫺ Time: ${now.time}
╰━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━${DECO}`
}

function menuData() {
    return {
        owner: [
            'mode', 'funmode on|off', 'restart', 'setbotname', 'setownername', 'setownernumber',
            'setprefix', 'setbio', 'setprofilepic', 'alwaysonline', 'autoread', 'anticall',
            'autoviewstatus', 'autoreactstatus', 'chatbot', 'autobio', 'autoblock', 'autorecord',
            'autorecordtyping', 'autotype', 'autosavestatus', 'block', 'unblock', 'unblockall',
            'listblocked', 'addsudo', 'delsudo', 'listsudo', 'warn', 'resetwarn', 'listwarn',
            'setgoodbye', 'setwelcome', 'delgoodbye', 'delwelcome', 'showgoodbye', 'showwelcome',
            'setanticallmsg', 'delanticallmsg', 'showanticallmsg', 'setaza', 'resetaza', 'aza',
            'statussettings', 'statusdelay', 'setstickerauthor', 'setstickerpackname', 'setwatermark',
            'setstatusemoji', 'setfont', 'setmenu', 'setmenuimage', 'resetsetting', 'settimezone',
            'news', 'fb', 'wa', 'tg', 'setfb', 'delete', 'broadcast', 'join', 'leave', 'hostip',
            'disk', 'allgroups', 'update', 'updatecode', 'tostatus', 'off', 'on', 'resetsessions', 'repair', 'repairlog',
        ],
        downloads: [
            'play', 'song', 'song2', 'ytmp3', 'ytmp4', 'yt', 'yta', 'ytv', 'spotify', 'video',
            'tiktok', 'tiktokaudio', 'tkvid', 'tkaudio', 'tt', 'ttaudio', 'ig', 'insta', 'twitter',
            'tweet', 'facebook', 'fbvid', 'mediafire', 'toaudio', 'toimg', 'tomp3', 'tovideo', 'movie',
            'music', 'mp3', 'spdl', 'torrent', 'download', 'dlvo', 'apk',
        ],
        auto: [
            'antilink', 'antispam', 'antisticker', 'antibug', 'antibot', 'antivoicenote', 'antiremove',
            'antigroupmention', 'antidelete', 'antiedit', 'antiviewonce', 'welcome', 'goodbye',
            'addbadword', 'deletebadword', 'listbadword', 'addignorelist', 'delignorelist',
            'listignorelist', 'addcountrycode', 'delcountrycode', 'listcountrycode', 'bancheck',
        ],
        ai: [
            'ai', 'ask', 'gpt', 'claude', 'gemini', 'deepseek', 'analyze', 'code', 'mycode', 'agent',
            'remember', 'agentrefresh', 'agentstatus', 'story', 'recipe', 'summarize', 'teach', 'generate', 'translate',
        ],
        groups: [
            'kick', 'add', 'ban', 'unban', 'promote', 'demote', 'mute', 'unmute', 'kickall', 'tagall',
            'tagadmin', 'admins', 'hidetag', 'poll', 'members', 'groupid', 'getgrouppp', 'invite', 'link',
            'totalmembers', 'getsettings', 'debugadmin', 'approve', 'reject', 'open', 'close', 'modestatus',
            'setgroupname', 'setdesc', 'resetlink', 'setppgroup', 'setcontextlink', 'gcaddprivacy', 'ppprivacy',
        ],
        github: [
            'repo', 'source', 'update', 'updatecode', 'agentstatus', 'agentrefresh',
        ],
        tools: [
            'sticker', 'toimage', 'toviewonce', 'remini', 'enhance', 'removebc', 'wallpaper', 'vv', 'vv2', 'reveal', 'save',
            'qrcode', 'tinyurl', 'shorten', 'shorturl', 'calculate', 'genpass', 'fancy', 'fliptext', 'weather',
            'define', 'getpp', 'getabout', 'device', 'dict', 'meaning', 'calc', 'math', 'say', 'react', 'pfp',
        ],
        search: ['lyrics', 'imdb', 'yts', 'gsmarena', 'moviesearch', 'toprated', 'moviedetails'],
        fun: ['fact', 'facts', 'joke', 'jokes', 'meme', 'memes', 'quotes', 'trivia', 'truth', 'dare', 'tod', 'truthordare', 'truthdetector', 'emojimix'],
        religion: ['bible', 'quran'],
        sports: [
            'sports', 'epl', 'eplmatches', 'eplstandings', 'eplscorers', 'eplupcoming',
            'laliga', 'laligamatches', 'laligastandings', 'laligascorers', 'laligaupcoming',
            'bundesliga', 'bundesligamatches', 'bundesligastandings', 'bundesligascorers', 'bundesligaupcoming',
            'seriea', 'serieamatches', 'serieastandings', 'serieascorers', 'serieaupcoming',
            'ligue1', 'ligue1matches', 'ligue1standings', 'ligue1scorers', 'ligue1upcoming',
            'clmatches', 'clstandings', 'clscorers', 'clupcoming', 'wcmatches', 'wcstandings', 'wcscorers',
            'wcupcoming', 'wrestlingevents', 'wwenews', 'wweschedule',
        ],
        custom: ['addcmd', 'editcmd', 'delcmd', 'listcmd', 'cmdinfo'],
        kali: ['kali <tool> [args]', 'kalicmds', 'ping2'],
        general: [
            'menu', 'help', 'ping', 'pong', 'runtime', 'uptime', 'botstatus', 'botping', 'botdate', 'botuptime',
            'owner', 'pair', 'time', 'userid', 'myid', 'feedback', 'report', 'about', 'bot', 'online', 'status',
            'whoami', 'summary', 'listcmds', 'mycmds', 'quote', 'repair',
        ],
    }
}

function uniqueCommandCount(data) {
    const set = new Set()
    for (const list of Object.values(data)) {
        for (const item of list) {
            const command = String(item).split(/\s+/)[0].trim().toLowerCase()
            if (command) set.add(command)
        }
    }
    return set.size
}

function buildMainMenu(data) {
    const menuCount = Object.keys(data).length
    const commandCount = uniqueCommandCount(data)
    const motto = config.themeLine || 'We are Anonymous. We are Legion…'
    const tagline = config.menuTagline || 'Independent code. One core. Many capabilities.'

    const sections = [
        ['👑 Owner', data.owner],
        ['📥 Downloads', data.downloads],
        ['🛡️ Auto / Protection', data.auto],
        ['⚡ AI Core', data.ai],
        ['👥 Group', data.groups],
        ['💻 Project / Github', data.github],
        ['🛠️ Tools', data.tools],
        ['🔎 Search', data.search],
        ['🎉 Fun', data.fun],
        ['📖 Faith', data.religion],
        ['⚽ Sports', data.sports],
        ['🧩 Custom', data.custom],
        ['🖥️ Kali / Linux', data.kali],
        ['📡 General', data.general],
    ]
    const sectionsText = sections.map(([title, cmds]) => box(title, cmds)).join(`\n${readMore}\n`)

    return `${statusBox(commandCount, menuCount)}\n\n_${tagline}_\n\n${sectionsText}\n\n『 🕶️ ${motto} 』\n『 ⚡ MAHNGUELOH VANTA • BUILT TO EVOLVE. 』\n_${getNow().timezone}_`
}

function buildCategoryMenus(data) {
    global.ownermenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('👑 Owner', data.owner)}`
    global.downloadmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('📥 Downloads', data.downloads)}`
    global.automenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🛡️ Auto / Protection', data.auto)}`
    global.aimenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('⚡ AI Core', data.ai)}`
    global.groupmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('👥 Group', data.groups)}`
    global.githubmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('💻 Github / Project', data.github)}`
    global.toolsmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🛠️ Tools', data.tools)}`
    global.utilitymenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🔮 Utility', data.general)}`
    global.exploitsmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🖥️ Kali / Linux', data.kali)}`
    global.funmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🎉 Fun', data.fun)}`
    global.reactmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('💫 Reaction', ['react'])}`
    global.gamemenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🎮 Fun / Game', data.fun)}`
    global.animemenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🎎 Visual Fun', ['meme', 'emojimix', 'wallpaper'])}`
    global.textmenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('✍️ Text / Effects', ['fliptext', 'fancy', 'say'])}`
    global.photomenu = `${statusBox(uniqueCommandCount(data), Object.keys(data).length)}\n\n${box('🖼️ Image / Visuals', ['wallpaper', 'remini', 'enhance', 'removebc', 'toimage', 'toimg'])}`
}

async function sendMenu(sock, from, sender, msg) {
    const data = menuData()
    const fullText = buildMainMenu(data)
    buildCategoryMenus(data)

    // Keep the existing reaction behavior.
    await fmt.react(sock, msg, '⚡')

    const bannerPath = path.join(__dirname, '../assets/banner.png')
    if (fs.existsSync(bannerPath)) {
        await sock.sendMessage(from, {
            image: fs.readFileSync(bannerPath),
            caption: fullText,
        }, { quoted: msg })
    } else {
        await sock.sendMessage(from, { text: fullText }, { quoted: msg })
    }

    // Let other modules access the same complete menu text without changing
    // the current handler contract.
    global.menu = fullText
}

module.exports = {
    sendMenu,
}
