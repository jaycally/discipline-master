const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// Simple database to store warnings (warnings.json)
const WARNINGS_FILE = './warnings.json';
let warnings = {};
if (fs.existsSync(WARNINGS_FILE)) {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE));
}

const saveWarnings = () => {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));
};

// Function to check if a message contains a link
const containsLink = (text) => {
    const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/\S*)?)/gi;
    return urlPattern.test(text);
};

// Connect to WhatsApp
const startBot = async () => {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // Shows QR in Railway logs
        auth: state,
    });

    // Show QR code in terminal (for Railway logs)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('Scan the QR code above with WhatsApp (Linked Devices)');
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot is online!');
        }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Listen for new messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return; // Ignore bot's own messages
        
        const sender = msg.key.participant || msg.key.remoteJid;
        const groupId = msg.key.remoteJid;
        const messageContent = msg.message.conversation || 
                               msg.message.extendedTextMessage?.text || 
                               msg.message.imageMessage?.caption || 
                               msg.message.videoMessage?.caption || 
                               '';

        // Only act in groups
        if (!groupId.endsWith('@g.us')) return;

        // 1. Delete mentions (@everyone)
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            // Check if it's a mass mention (more than 5 people) or an @everyone pattern
            const mentionedCount = msg.message.extendedTextMessage.contextInfo.mentionedJid.length;
            if (mentionedCount >= 5 || messageContent.includes('@everyone')) {
                await sock.sendMessage(groupId, { delete: msg.key });
                await sock.sendMessage(groupId, { 
                    text: `@${sender.split('@')[0]} mass mentions are not allowed.`,
                    mentions: [sender]
                });
                return;
            }
        }

        // 2. Delete links and apply warnings
        if (containsLink(messageContent)) {
            await sock.sendMessage(groupId, { delete: msg.key });
            
            // Initialize warning tracker
            if (!warnings[groupId]) warnings[groupId] = {};
            if (!warnings[groupId][sender]) warnings[groupId][sender] = 0;
            
            warnings[groupId][sender]++;
            saveWarnings();
            
            const warnCount = warnings[groupId][sender];
            
            if (warnCount >= 3) {
                // Kick user
                await sock.groupParticipantsUpdate(groupId, [sender], 'remove');
                await sock.sendMessage(groupId, { 
                    text: `@${sender.split('@')[0]} has been kicked for sending links 3 times.`,
                    mentions: [sender]
                });
                // Reset warnings
                delete warnings[groupId][sender];
                saveWarnings();
            } else {
                // Send warning message
                await sock.sendMessage(groupId, { 
                    text: `@${sender.split('@')[0]} links are not allowed. Warning ${warnCount}/3.`,
                    mentions: [sender]
                });
            }
        }
    });
};

startBot();