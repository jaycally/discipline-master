const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const WARNINGS_FILE = './warnings.json';
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
}
const saveWarnings = () => fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));

const containsLink = (text) => /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/\S*)?)/gi.test(text);

// Create auth folder (important for Railway Volume)
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_FOLDER)) {
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

const startBot = async () => {
    let authState;
    const sessionId = process.env.SESSION_ID;

    if (sessionId) {
        // Keep your original SESSION_ID support
        try {
            const decoded = Buffer.from(sessionId, 'base64').toString('utf-8');
            const creds = JSON.parse(decoded);
            authState = { state: { creds, keys: {} }, saveCreds: () => {} };
            console.log('✅ Using provided SESSION_ID');
        } catch (e) {
            console.log('Invalid SESSION_ID, falling back to normal auth...');
            authState = await useMultiFileAuthState(AUTH_FOLDER);
        }
    } else {
        authState = await useMultiFileAuthState(AUTH_FOLDER);
    }

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: authState.state.creds,
            keys: makeCacheableSignalKeyStore(authState.state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,     // Disabled - we use pairing code
        browser: ['Chrome', 'Desktop', '1.0'],
        markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', authState.saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR received but we are using pairing code instead.');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Status: ${statusCode}. Reconnecting...`);

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => startBot(), 5000); // Wait 5 seconds before reconnect
            } else {
                console.log('❌ Logged out. Delete auth_info folder and restart the bot.');
            }
        } 
        else if (connection === 'open') {
            console.log('✅ Discipline Master is ONLINE and moderating the group!');
        }
    });

    // === Pairing Code (Best for Railway) ===
    if (!authState.state.creds.registered) {
        console.log('🔢 Requesting pairing code...');
        const phoneNumber = '2547XXXXXXXXXX';   // ←←← CHANGE THIS TO YOUR WHATSAPP NUMBER (no +)
        
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log('\n════════════════════════════════════');
            console.log(`📱 YOUR PAIRING CODE: ${code}`);
            console.log('════════════════════════════════════');
            console.log('Go to WhatsApp on your phone → Linked Devices → "Link a Device"');
            console.log('Choose "Link with phone number" and enter the code above.\n');
        } catch (err) {
            console.error('Failed to generate pairing code:', err.message);
        }
    }

    // Message handler (your original logic - unchanged)
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

        // Delete mass mentions
        const mentions = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (mentions.length >= 5 || messageContent.includes('@everyone')) {
            await sock.sendMessage(groupId, { delete: msg.key });
            await sock.sendMessage(groupId, { 
                text: `@${sender.split('@')[0]} mass mentions are not allowed.`, 
                mentions: [sender] 
            });
            return;
        }

        // Anti-link with 3-strike kick
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

startBot().catch(err => {
    console.error('Fatal error:', err);
});
