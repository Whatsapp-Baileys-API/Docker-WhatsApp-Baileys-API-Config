import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs-extra';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import qrcodeTerminal from 'qrcode-terminal';
// --- NEW IMPORT ---
import axios from 'axios'; // Import axios to send webhooks

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Instance {
    key;
    sessionDir;
    sock;
    qr;
    status = 'loading';
    // --- NEW PROPERTY ---
    webhookUrl; // Store the webhook URL

    // --- UPDATED CONSTRUCTOR ---
    constructor(key, webhookUrl = null) { // Accept webhookUrl
        this.key = key;
        this.webhookUrl = webhookUrl; // Set the webhook URL
        this.sessionDir = path.join(__dirname, '..', '..', 'sessions', this.key);
        fs.ensureDirSync(this.sessionDir);
    }

    // --- NEW FUNCTION ---
    // This function sends data to the user's webhook
    async sendWebhook(type, data) {
        if (!this.webhookUrl) return; // Do nothing if no webhook is set

        try {
            await axios.post(this.webhookUrl, {
                key: this.key, // So the user knows which instance this is from
                event: type,   // e.g., 'message', 'connection'
                data: data,      // The actual event data
            });
        } catch (error) {
            console.error(`[${this.key}] Error sending webhook for ${type}:`, error.message);
        }
    }

    async init() {
        const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[${this.key}] Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);

        this.sock = makeWASocket({
            version,
            printQRInTerminal: false,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['My-API', 'Chrome', '1.0.0'],
        });

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                this.qr = qr;
                this.status = 'qr';
                console.log(`[${this.key}] QR code available. Scan to login.`);
                qrcodeTerminal.generate(qr, { small: true });
                console.log(`[${this.key}] Scan the QR code above or open in browser: http://localhost:3000/instance/qr/${this.key}`);
            }

            if (connection === 'close') {
                const shouldReconnect =
                    (lastDisconnect.error instanceof Boom)?.output?.statusCode !==
                    DisconnectReason.loggedOut;
                
                this.status = 'disconnected';
                console.log(
                    `[${this.key}] Connection closed: ${lastDisconnect.error}, reconnecting: ${shouldReconnect}`
                );

                if (shouldReconnect) {
                    this.init();
                } else {
                    fs.rmSync(this.sessionDir, { recursive: true, force: true });
                    this.status = 'logged-out';
                    console.log(`[${this.key}] Logged out, session cleared.`);
                }
            } else if (connection === 'open') {
                this.status = 'connected';
                this.qr = null;
                console.log(`[${this.key}] Connection opened! Ready to use.`);
            }

            // --- SEND WEBHOOK ON CONNECTION UPDATE ---
            this.sendWebhook('connection', { 
                connection: this.status, 
                ...update 
            });
        });

        // --- NEW EVENT HANDLER FOR MESSAGES ---
        this.sock.ev.on('messages.upsert', (m) => {
            // "notify" is the event for a new message
            if (m.type === 'notify') {
                // Send the whole message object to the webhook
                this.sendWebhook('message', m);
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        return this;
    }

    // ---- Helper Functions (rest of file is the same) ----
    // ... (sendText, sendMedia, etc. are all unchanged) ...
    getWhatsAppId(number) {
        if (number.includes('@')) {
            return number;
        }
        return number.includes('-')
            ? `${number}@g.us`
            : `${number}@s.whatsapp.net`;
    }

    async onWhatsApp(id) {
        if (!this.sock) {
            throw new Error('Instance not initialized');
        }
        const jid = this.getWhatsAppId(id);
        const [result] = await this.sock.onWhatsApp(jid);
        return result?.exists || false;
    }

    async sendText(to, message) {
        if (!this.sock) {
            throw new Error('Instance not initialized');
        }
        const jid = this.getWhatsAppId(to);
        return await this.sock.sendMessage(jid, { text: message });
    }

    async sendMedia(to, filePath, type, caption = '', filename = '') {
        if (!this.sock) {
            throw new Error('Instance not initialized');
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found at path: ${filePath}`);
        }

        const jid = this.getWhatsAppId(to);
        const mediaPayload = {
            [type]: {
                url: filePath,
            },
            caption: caption,
        };

        if (type === 'document') {
            mediaPayload.fileName = filename || path.basename(filePath);
        }
        if (type === 'audio') {
            mediaPayload.ptt = true;
        }

        return await this.sock.sendMessage(jid, mediaPayload);
    }
}

export default Instance;

