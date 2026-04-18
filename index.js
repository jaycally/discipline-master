const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const WARNINGS_FILE = './warnings.json';
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf-8'));
}
const saveWarnings = () => fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));

const containsLink = (text) => /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/\S*)?)/gi.test(text);

const AUTH_FOLDER = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

const startBot = async () => {
    const authState = await useMultiFileAuthState(AUTH_FOLDER);

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: authState.state.creds,
            keys: makeCacheableSignalKeyStore(authState.state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: true,           // ← QR enabled
        browser: ['Chrome', 'Desktop', '1.0'],
        markOnlineOnConnect: false,
        connectTimeoutMs: 90000,          // longer timeout
        defaultQueryTimeoutMs: 90000,
    });

    sock.ev.on('creds.update', authState.saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n🔳 SCAN THIS QR CODE WITH WHATSAPP (Linked Devices):\n');
            console.log(qr);   // This big string is the QR
            console.log('\n→ Open WhatsApp → Linked Devices → Link a Device → Scan QR');
            console.log('→ Or screenshot this log and scan from another phone if needed.\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Connection closed. Status: ${statusCode || 'unknown'}`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Delete auth_info folder and redeploy if needed.');
                return;
            }

            console.log('🔄 Reconnecting in 12 seconds...');
            setTimeout(() => startBot(), 12000);
        } 
        else if (connection === 'open') {
            console.log('✅ Discipline Master is ONLINE and moderating the group!');
            console.log('Bot is now active — test by sending a link in your group.');
        }
    });

    // === Your original moderation logic (unchanged) ===
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const groupId = msg.key.remoteJid;
        if (!groupId.endsWith('@g.us')) return;

        const messageContent = msg.message.conversation ||
                               msg.message.extendedTextMessage?.text ||
                               msg.message.imageMessage?.caption ||
                               msg.message.videoMessage?.caption || '';

        // Mass mentions
        const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentions.length >= 5 || messageContent.includes('@everyone')) {
            await sock.sendMessage(groupId, { delete: msg.key });
            await sock.sendMessage(groupId, { 
                text: `@${sender.split('@')[0]} mass mentions are not allowed.`, 
                mentions: [sender] 
            });
            return;
        }

        // Anti-link 3 strikes
        if (containsLink(messageContent)) {
            await sock.sendMessage(groupId, { delete: msg.key });

            if (!warnings[groupId]) warnings[groupId] = {};
            if (!warnings[groupId][sender]) warnings[groupId][sender] = 0;

            warnings[groupId][sender]++;
            saveWarnings();

            const warnCount = warnings[groupId][sender];

            if (warnCount >= 3) {
                await sock.groupParticipantsUpdate(groupId, [sender], 'remove');
                await sock.sendMessage(groupId, { 
                    text: `@${sender.split('@')[0]} kicked (3 link strikes).`, 
                    mentions: [sender] 
                });
                delete warnings[groupId][sender];
                saveWarnings();
            } else {
                await sock.sendMessage(groupId, { 
                    text: `@${sender.split('@')[0]} links not allowed. Warning ${warnCount}/3.`, 
                    mentions: [sender] 
                });
            }
        }
    });
};

startBot().catch(err => console.error('Fatal error:', err));
