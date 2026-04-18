const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const readline = require('readline');

// Simple database for warnings
const WARNINGS_FILE = './warnings.json';
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
const saveWarnings = () => fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));

const containsLink = (text) => /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/\S*)?)/gi.test(text);

const startBot = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false, // We'll use pairing code instead
    });

    // Use pairing code (no QR needed)
    if (!sock.authState.creds.registered) {
        console.log('\n🔑 Generating pairing code...');
        const phoneNumber = process.env.PHONE_NUMBER; // Optional: set your bot's number with country code
        const code = await sock.requestPairingCode(phoneNumber || '');
        console.log('\n=========================================');
        console.log(`   YOUR PAIRING CODE: ${code}`);
        console.log('=========================================');
        console.log('\n1. Open WhatsApp on your phone');
        console.log('2. Go to Settings > Linked Devices > Link a Device');
        console.log('3. Tap "Link with Phone Number Instead"');
        console.log(`4. Enter the code: ${code}`);
        console.log('\nWaiting for connection...\n');
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Discipline Master is online!');
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
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length >= 5 || messageContent.includes('@everyone')) {
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
