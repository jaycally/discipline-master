const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');

const WARNINGS_FILE = './warnings.json';
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
const saveWarnings = () => fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));

const containsLink = (text) => /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/\S*)?)/gi.test(text);

// Function to decode session ID if provided
const getAuthFromSession = async (sessionId) => {
    if (!sessionId) return null;
    try {
        // If sessionId is base64 encoded JSON
        const decoded = Buffer.from(sessionId, 'base64').toString('utf-8');
        const creds = JSON.parse(decoded);
        return { creds, keys: {} };
    } catch (e) {
        console.error('Invalid SESSION_ID format. Falling back to QR.');
        return null;
    }
};

const startBot = async () => {
    const sessionId = process.env.SESSION_ID;
    let authState;

    if (sessionId) {
        const customAuth = await getAuthFromSession(sessionId);
        if (customAuth) {
            authState = { state: customAuth, saveCreds: () => {} };
            console.log('✅ Using provided SESSION_ID');
        } else {
            authState = await useMultiFileAuthState('auth_info');
        }
    } else {
        authState = await useMultiFileAuthState('auth_info');
    }

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: authState.state,
        printQRInTerminal: true, // Will show QR if no session works
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n🔳 SCAN THIS QR CODE WITH WHATSAPP (Linked Devices):\n');
            console.log(qr);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Discipline Master is ONLINE!');
        }
    });

    sock.ev.on('creds.update', authState.saveCreds);

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
            await sock.sendMessage(groupId, { text: `@${sender.split('@')[0]} mass mentions are not allowed.`, mentions: [sender] });
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
                await sock.sendMessage(groupId, { text: `@${sender.split('@')[0]} kicked (3 link strikes).`, mentions: [sender] });
                delete warnings[groupId][sender];
                saveWarnings();
            } else {
                await sock.sendMessage(groupId, { text: `@${sender.split('@')[0]} links not allowed. Warning ${warnCount}/3.`, mentions: [sender] });
            }
        }
    });
};

startBot();
