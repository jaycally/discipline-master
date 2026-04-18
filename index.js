const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');

const WARNINGS_FILE = './warnings.json';
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
const saveWarnings = () => fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));

const containsLink = (text) => /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/\S*)?)/gi.test(text);

const startBot = async () => {
    // Load session from environment variable
    const sessionId = process.env.SESSION_ID;
    let state, saveCreds;
    
    if (sessionId) {
        // Use provided Session ID
        const { state: s, saveCreds: sc } = await useMultiFileAuthState('auth_info');
        // Decode and inject session (simplified; we'll use a helper)
        const { decode } = require('@whiskeysockets/baileys/lib/Utils');
        const creds = decode(sessionId);
        await s.creds.set(creds);
        state = s;
        saveCreds = sc;
        console.log('✅ Session ID loaded. Connecting...');
    } else {
        // Fallback to normal auth (will require QR/pairing)
        const auth = await useMultiFileAuthState('auth_info');
        state = auth.state;
        saveCreds = auth.saveCreds;
        console.log('No SESSION_ID found. QR code will be printed.');
    }

    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: !sessionId, // Show QR only if no session
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n🔳 SCAN THIS QR CODE:\n');
            console.log(qr);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Discipline Master is ONLINE and protecting your group!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

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
