import makeWASocket, {
    DisconnectReason,
    // We are NOT using useMultiFileAuthState
    fetchLatestBaileysVersion,
    downloadMediaMessage,
    WAProto, // WAProto is needed to revive messages from the DB
    initAuthCreds,
    BufferJSON
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
        const cachedKeys = new Map();

        const writeAuthData = async (key, data) => {
            try {
                // Convert buffers to JSON-safe format before storing
                const jsonData = JSON.stringify(data, BufferJSON.replacer);
                if (jsonData === undefined) {
                    console.warn(`[${this.key}] No auth payload for key ${key}, skipping write.`);
                    return;
                }
                const query = `
                    INSERT INTO ${authTable} (key_id, key_data) 
                    VALUES ($1, $2::jsonb) 
                    ON CONFLICT (key_id) 
                    DO UPDATE SET key_data = EXCLUDED.key_data;
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
                    return JSON.parse(JSON.stringify(rows[0].key_data), BufferJSON.reviver);
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
                cachedKeys.clear();
                console.log(`[${this.key}] All auth data removed from DB.`);
            } catch (error) {
                console.error(`[${this.key}] Error removing all auth data:`, error);
            }
        };

        const creds = (await readAuthData('creds')) || initAuthCreds();

        const keys = {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(
                    ids.map(async (id) => {
                        const keyId = `${type}-${id}`;
                        if (cachedKeys.has(keyId)) {
                            data[id] = cachedKeys.get(keyId);
                            return;
                        }

                        const value = await readAuthData(keyId);
                        if (!value) {
                            return;
                        }

                        const hydrated =
                            type === 'app-state-sync-key'
                                ? WAProto.Message.AppStateSyncKeyData.fromObject(value)
                                : value;

                        cachedKeys.set(keyId, hydrated);
                        data[id] = hydrated;
                    })
                );
                return data;
            },
            set: async (data) => {
                const promises = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const keyId = `${category}-${id}`;
                        if (value) {
                            cachedKeys.set(keyId, value);
                            promises.push(writeAuthData(keyId, value));
                        } else {
                            cachedKeys.delete(keyId);
                            promises.push(removeAuthData(keyId));
                        }
                    }
                }
                await Promise.all(promises);
            },
        };

        return {
            state: {
                creds,
                keys,
            },
            // This is the function Baileys will call to save creds
            saveCreds: () => writeAuthData('creds', creds),
            // Add a helper to wipe all session data
            removeAllAuthData,
        };
    }

    async initialize() {
        // Wrap the entire initialization in a Promise to handle the async nature of connection.update
        return new Promise(async (resolve, reject) => {
            try {
                console.log(`[${this.key}] Initializing instance...`);
                
                // Ensure directories exist (only for downloads now)
                if (!fs.existsSync(downloadsDir)) {
                    fs.mkdirSync(downloadsDir, { recursive: true });
                }
                
                // --- Use our custom Postgres auth state ---
                const { state, saveCreds, removeAllAuthData } = await this.createPostgresAuthState();
                
                // We now pass this function to our cleanup logic
                this.removeAllAuthData = removeAllAuthData;
                
                const { version, isLatest } = await fetchLatestBaileysVersion();
                
                console.log(`[${this.key}] Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);

                this.socket = makeWASocket({
                    version,
                    printQRInTerminal: false,
                    auth: state,
                    logger: pino({ level: 'silent' }),
                    browser: ['MyVibeBot', 'Chrome', '1.0.0'],
                    getMessage: this.getMessage.bind(this)
                });

                // This listener will resolve the promise once we have a definitive state
                this.socket.ev.on('connection.update', (update) => {
                    const { connection, lastDisconnect, qr } = update;
                    if (connection === 'open') {
                        console.log(`[${this.key}] Initialization successful, connection open.`);
                        resolve(this); // Resolve the promise on successful connection
                    } else if (qr) {
                        console.log(`[${this.key}] Initialization successful, QR code available.`);
                        resolve(this); // Resolve the promise when QR is available
                    } else if (connection === 'close') {
                        // If it's a logout, we don't want to retry. Reject the promise.
                        if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                            console.error(`[${this.key}] Initialization failed: Logged out.`);
                            reject(new Error('Connection closed: Logged Out'));
                        }
                        // For other errors, Baileys will attempt to reconnect automatically.
                        // We don't resolve or reject, just let it retry.
                    }
                });

                // Set up all other event listeners
                this.setupEventListeners();

                // Save credentials on update
                this.socket.ev.on('creds.update', saveCreds);
            } catch (error) {
                console.error(`[${this.key}] Critical error during initialization:`, error);
                reject(error);
            }
        });
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
        // --- IMPORTANT ---
        // The primary connection.update logic is now inside the initialize() Promise.
        // This listener handles ongoing status changes AFTER initialization.
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                this.status = 'disconnected';
                console.log(`[${this.key}] Connection closed: ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`);
                
                this.sendWebhook('connection', { 
                    connection: 'disconnected', 
                    error: lastDisconnect?.error?.message 
                });

                if (!shouldReconnect) {
                    console.log(`[${this.key}] Logged out. Deleting session.`);
                    void this.cleanup();
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
                            VALUES ($1, $2::jsonb) 
                            ON CONFLICT (message_id) 
                            DO UPDATE SET message_data = EXCLUDED.message_data;
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
    async sendMedia(to, filePath, caption = '', fileType = 'document', originalFileName = undefined) {
        if (this.status !== 'connected') return { error: 'Instance not connected' };
        
        let mediaConfig = {};
        const fileName = originalFileName || path.basename(filePath);
        
        if (fileType === 'image') {
            mediaConfig = { image: { url: filePath }, caption };
        } else if (fileType === 'video') {
            mediaConfig = { video: { url: filePath }, caption };
        } else if (fileType === 'audio') {
            mediaConfig = { audio: { url: filePath }, mimetype: 'audio/mp4' };
        } else {
            mediaConfig = { document: { url: filePath }, caption, fileName };
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
            try {
                await this.removeAllAuthData();
            } catch (error) {
                console.error(`[${this.key}] Failed to remove auth data during cleanup:`, error);
            }
        }

        if (globalThis?.instances instanceof Map) {
            globalThis.instances.delete(this.key);
        }
    }
}
