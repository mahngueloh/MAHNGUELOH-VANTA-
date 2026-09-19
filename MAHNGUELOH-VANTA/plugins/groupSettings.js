// Per-group settings
// antiAction options: 'warn' | 'delete' | 'kick'
const groupSettings = {}

function getSettings(groupId) {
    if (!groupSettings[groupId]) {
        groupSettings[groupId] = {
            antilink: false,
            antilinkAction: 'warn',      // warn | delete | kick
            antispam: false,
            antispamAction: 'kick',
            antisticker: false,
            antistickerAction: 'delete',
            antivoicenote: false,
            antivoicenoteAction: 'delete',
            antibug: false,
            antibugAction: 'kick',
            antiremove: false,
            antibadword: false,
            antibadwordAction: 'warn',
            antibot: false,
            antidemote: false,
            antiforeign: false,
            welcome: false,
            goodbye: false,
        }
    }
    return groupSettings[groupId]
}

function setSetting(groupId, key, value) {
    getSettings(groupId)[key] = value
}

module.exports = { getSettings, setSetting }
