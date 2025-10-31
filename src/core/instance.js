import {
    default as makeWASocket,
    DisconnectReason,
    // We are NOT using useMultiFileAuthState
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    WAProto // WAProto is needed to revive messages from the DB
} from '@whiskeysockets/baileys';
import { pino } from 'pino';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path, { join, dirname } from 'path';
import qrcode from 'qrcode-terminal';
import axios from 'axios'; // For webhooks
import dbPool from './db.js'; // Import our Postgres pool

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Downloads directory path (still needed for media files) ---
const downloadsDir = join(__dirname, '..', '..', 'downloads');

// --- Helper function to convert Buffer to a JSON-safe format ---
// This is critical for storing auth state in Postgres JSONB
const BufferJSON = {
    replacer: (key, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
            return {
                type: 'Buffer',
                data: Buffer.from(value?.data || value).toString('base64'),
            };
        }
        return value;
    },
    reviver: (key, value) => {
        if (typeof value === 'object' && value !== null && (value.buffer === true || value.type === 'Buffer')) {
            return Buffer.from(value.data || value.value, 'base64');
        }
        return value;
    },
};

// --- THIS IS A NAMED EXPORT ---
export class Instance {
    key = '';
    webhookUrl = '';
    status = 'loading';
    socket = null;
    qr = '';
    // This will be populated by createPostgresAuthState
    removeAllAuthData = null;

    constructor(key, webhookUrl = null) {
        this.key = key;
        this.webhookUrl = webhookUrl;
        this.initialize();
    }

    // --- This function now queries Postgres ---
    async getMessage(key) {
        try {
            const query = 'SELECT message_data FROM baileys_message_store WHERE message_id = $1';
            const { rows } = await dbPool.query(query, [key.id]);
            
            if (rows.length > 0) {
                // Revive the message data from JSONB
                const messageData = JSON.parse(JSON.stringify(rows[0].message_data), BufferJSON.reviver);
                // Re-hydrate the message object to the correct Baileys prototype
                return WAProto.Message.fromObject(messageData);
            }
            console.log(`[${this.key}] getMessage: No message found in DB for id: ${key.id}`);
            return undefined;

        } catch (error) {
            console.error(`[${this.key}] Error in getMessage:`, error);
            return undefined;
        }
    }

    // --- This creates our custom auth state handlers for Postgres ---
    async createPostgresAuthState() {
        const authTable = 'baileys_auth_store';
        // Prefix keys with the instance key to support multi-device
        const instanceKeyPrefix = `auth-${this.key}-`;

        const writeAuthData = async (key, data) => {
            try {
                // Convert buffers to JSON-safe format before storing
                const jsonData = JSON.stringify(data, BufferJSON.replacer);
                const query = `
                    INSERT INTO ${authTable} (key_id, key_data) 
                    VALUES ($1, $2) 
                    ON CONFLICT (key_id) 
                    DO UPDATE SET key_data = $2;
                `;
                await dbPool.query(query, [instanceKeyPrefix + key, jsonData]);
            } catch (error) {
                console.error(`[${this.key}] Error writing auth data for key ${key}:`, error);
            }
        };

        const readAuthData = async (key) => {
            try {
                const query = `SELECT key_data FROM ${authTable} WHERE key_id = $1;`;
                const { rows } = await dbPool.query(query, [instanceKeyPrefix + key]);
                
                if (rows.length > 0) {
                    // Revive buffers from JSON-safe format
                    const data = JSON.parse(JSON.stringify(rows[0].key_data), BufferJSON.reviver);
                    return data;
                }
                return null;
            } catch (error) {
                console.error(`[${this.key}] Error reading auth data for key ${key}:`, error);
                return null;
            }
        };

        const removeAuthData = async (key) => {
            try {
                const query = `DELETE FROM ${authTable} WHERE key_id = $1;`;
                await dbPool.query(query, [instanceKeyPrefix + key]);
            } catch (error) {
                console.error(`[${this.key}] Error removing auth data for key ${key}:`, error);
            }
        };
        
        const removeAllAuthData = async () => {
             try {
                const query = `DELETE FROM ${authTable} WHERE key_id LIKE $1;`;
                await dbPool.query(query, [`${instanceKeyPrefix}%`]);
                console.log(`[${this.key}] All auth data removed from DB.`);
            } catch (error) {
                console.error(`[${this.key}] Error removing all auth data:`, error);
            }
        }

        // We load 'creds' manually once
        const creds = await readAuthData('creds') || {};

        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const data = {};
                        await Promise.all(
                            ids.map(async (id) => {
                                let value = await readAuthData(`${type}-${id}`);
                                if (type === 'app-state-sync-key' && value) {
                                    value = WAProto.Message.AppStateSyncKeyData.fromObject(value);
                                }
                                data[id] = value;
                            })
                        );
                        return data;
                    },
                    set: async (data) => {
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id];
                                const key = `${category}-${id}`;
                                if (value) {
                                    await writeAuthData(key, value);
                                } else {
                                    await removeAuthData(key);
                                }
                            }
                        }
                    },
                },
            },
            // This is the function Baileys will call to save creds
            saveCreds: () => writeAuthData('creds', creds),
            // Add a helper to wipe all session data
            removeAllAuthData
        };
    }

    async initialize() {
        console.log(`Creating instance: ${this.key}`);
        
        // Ensure directories exist (only for downloads now)
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir, { recursive: true });
        }
        
        // --- Use our custom Postgres auth state ---
        const { state, saveCreds, removeAllAuthData } = await this.createPostgresAuthState();
        
        // We now pass this function to our cleanup logic
        this.removeAllAuthData = removeAllAuthData;
        
        // --- THIS IS THE FIX ---
        // Fetches the latest version instead of using a hardcoded one
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        console.log(`[${this.key}] Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);

        this.socket = makeWASocket({
            version,
            printQRInTerminal: false,
            // Use the Postgres auth state
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['MyVibeBot', 'Chrome', '1.0.0'],
            // Pass our Postgres-backed getMessage function
            getMessage: this.getMessage.bind(this)
        });

        // Set up all event listeners
        this.setupEventListeners();

        // Save credentials on update
        this.socket.ev.on('creds.update', saveCreds);
    }

    async sendWebhook(event, data) {
        if (!this.webhookUrl) return; 

        try {
            await axios.post(this.webhookUrl, {
                key: this.key, 
                event: event, 
                data: data    
            });
        } catch (error) {
            console.error(`[${this.key}] Error sending webhook for event ${event}:`, error.message);
        }
    }
    
    // --- Main event handler setup ---
    setupEventListeners() {
        // Handle connection updates
        this.socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                this.qr = qr;
                this.status = 'qr';
                console.log(`[${this.key}] QR code available. Scan to login.`);
                qrcode.generate(qr, { small: true });
                console.log(`[${this.key}] Scan the QR code above or open in browser: http://localhost:3000/instance/qr/${this.key}`);
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
                this.status = 'disconnected';
                console.log(`[${this.key}] Connection closed: ${lastDisconnect.error}, reconnecting: ${shouldReconnect}`);
                
                this.sendWebhook('connection', { 
                    connection: 'disconnected', 
                    error: lastDisconnect.error?.message 
                });

                if (shouldReconnect) {
                    this.initialize(); // Re-initialize
                } else {
                    console.log(`[${this.key}] Logged out. Deleting session.`);
                    this.cleanup();
                }
            } else if (connection === 'open') {
                this.status = 'connected';
                this.qr = ''; // Clear QR on successful login
                console.log(`[${this.key}] Connection opened! Ready to use.`);
                this.sendWebhook('connection', { connection: 'connected' });
            }
        });

        // --- Handle incoming messages ---
        this.socket.ev.on('messages.upsert', async (m) => {
            console.log(`[${this.key}] Received messages.upsert (type: ${m.type})`);

            // --- Save every message to Postgres ---
            for (const message of m.messages) {
                if (message.key.id) {
                    try {
                        // Convert buffers to JSON-safe format
                        const messageData = JSON.stringify(message, BufferJSON.replacer);
                        const query = `
                            INSERT INTO baileys_message_store (message_id, message_data) 
                            VALUES ($1, $2) 
                            ON CONFLICT (message_id) 
                            DO UPDATE SET message_data = $2;
                        `;
                        await dbPool.query(query, [message.key.id, messageData]);
                    } catch (error) {
                        console.error(`[${this.key}] Error saving message to DB:`, error);
                    }
                }
            }
            
            // Send to webhook
            this.sendWebhook('message', {
                messages: m.messages,
                type: m.type
            });
        });

        // Handle Group Participant Changes
        this.socket.ev.on('group-participants.update', (update) => {
            console.log(`[${this.key}] Received group-participants.update`);
            this.sendWebhook('group-participants', update);
        });
    }

    // --- API Functions (called by your routes) ---

    // Send a text message
    async sendText(to, message) {
        if (this.status !== 'connected') return { error: 'Instance not connected' };
        try {
            return await this.socket.sendMessage(to, { text: message });
        } catch (error) {
            console.error(`[${this.key}] Error sending text:`, error);
            return { error: 'Failed to send message' };
        }
    }

    // Send a media file
    async sendMedia(to, filePath, caption = '', fileType) {
        if (this.status !== 'connected') return { error: 'Instance not connected' };
        
        let mediaConfig = {};
        
        if (fileType === 'image') {
            mediaConfig = { image: { url: filePath }, caption: caption };
        } else if (fileType === 'video') {
            mediaConfig = { video: { url:filePath }, caption: caption };
        } else if (fileType === 'audio') {
            mediaConfig = { audio: { url: filePath }, mimetype: 'audio/mp4' }; 
        } else {
            mediaConfig = { document: { url: filePath }, caption: caption, fileName: path.basename(filePath) };
        }

        try {
            return await this.socket.sendMessage(to, mediaConfig);
        } catch (error) {
            console.error(`[${this.key}] Error sending media:`, error);
            return { error: 'Failed to send media' };
        }
    }

    // Download media from a message
    async downloadMedia(message) {
        if (this.status !== 'connected') return { error: 'Instance not connected' };

        try {
            // Find the media part of the message
            const mediaType = Object.keys(message.message || {}).find(k => k.endsWith('Message'));
            if (!mediaType) {
                return { error: 'No media found in message' };
            }
            
            // Download the media
            const stream = await downloadMediaMessage(
                message, 
                'buffer', 
                {}, 
                { logger: pino({ level: 'silent' }) }
            );

            // Create a unique filename
            const extension = mediaType.replace('Message', '').toLowerCase();
            const filename = `${message.key.id}.${extension}`;
            const filePath = join(downloadsDir, filename);

            // Save the file
            fs.writeFileSync(filePath, stream);

            return { success: true, filename: filename };

        } catch (error) {
            console.error(`[${this.key}] Error downloading media:`, error);
            return { error: 'Failed to download media' };
        }
    }


    // --- Cleanup function ---
    async cleanup() {
        console.log(`[${this.key}] Cleaning up instance.`);
        this.socket?.ev.removeAllListeners();
        this.socket = null;
        this.status = 'destroyed';
        
        // --- Clear the auth data from Postgres ---
        if (this.removeAllAuthData) {
            await this.removeAllAuthData();
        }
    }
}

