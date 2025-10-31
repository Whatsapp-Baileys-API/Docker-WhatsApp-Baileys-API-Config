import express from 'express';
import multer from 'multer';
import instanceRoutes from './api/instanceRoutes.js';
import messageRoutes from './api/messageRoutes.js'; 

const app = express();
const port = 3000;

global.instances = new Map();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const upload = multer();

// "Plug in" our control panels
app.use('/instance', instanceRoutes);
app.use('/message', messageRoutes); 

// --- UPDATED WEBHOOK TESTER (NOW A KEYWORD BOT!) ---
app.post('/webhook-tester', async (req, res) => {
    console.log('--- ✅ WEBHOOK RECEIVED! ---');
    
    // Send a "we got it" response right away
    res.status(200).json({ received: true });

    // --- START OF UPGRADED BOT LOGIC ---
    try {
        const { key, event, data } = req.body;

        // 1. Check if it's a new message event
        if (event === 'message' && data.type === 'notify') {
            const instance = global.instances.get(key);
            if (!instance || instance.status !== 'connected') {
                console.log(`[${key}] Instance not ready, skipping.`);
                return;
            }

            // 2. Loop through all new messages
            for (const message of data.messages) {
                // 3. --- CRITICAL: PREVENT INFINITE LOOP ---
                if (message.key.fromMe) {
                    console.log(`[${key}] Ignoring own message (fromMe: true)`);
                    continue; 
                }

                // 4. --- NEW: Check if it's a Group or DM ---
                // DMs end in @s.whatsapp.net, Groups end in @g.us
                const senderJid = message.key.remoteJid;
                const isGroup = senderJid.endsWith('@g.us');

                // 5. --- We will ONLY reply in DMs for this bot ---
                if (isGroup) {
                    console.log(`[${key}] Ignoring message from group: ${senderJid}`);
                    continue; // Skip this message
                }

                // 6. --- Bot Logic for DMs ---
                const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
                
                // --- NEW: Check for media messages ---
                // Find any key that ends with 'Message' (e.g., imageMessage, videoMessage)
                const mediaType = Object.keys(message.message || {}).find(k => k.endsWith('Message'));

                if (text) {
                    // --- Text Message Logic ---
                    const command = text.toLowerCase().trim();
                    console.log(`[${key}] Received text from ${senderJid}: "${command}"`);
                    
                    if (command === '!help') {
                        const helpMsg = `*Bot Menu:*\n\n1. \`!help\` - See this menu.\n2. \`!ping\` - Check if I'm alive.\n3. Send an image/video.\n4. Send any other text to get it echoed.`;
                        await instance.sendText(senderJid, helpMsg);
                    
                    } else if (command === '!ping') {
                        await instance.sendText(senderJid, 'Pong! 🏓');
                    
                    } else {
                        // The old echo logic
                        await instance.sendText(senderJid, `You said: ${text}`);
                    }

                } else if (mediaType && mediaType !== 'protocolMessage' && mediaType !== 'senderKeyDistributionMessage') {
                    // --- NEW: Acknowledge Media ---
                    // This will catch 'imageMessage', 'videoMessage', 'stickerMessage', etc.
                    const friendlyMediaType = mediaType.replace('Message', '');
                    console.log(`[${key}] Received media type (${friendlyMediaType}) from ${senderJid}`);
                    await instance.sendText(senderJid, `Cool ${friendlyMediaType}! 👍`);

                } else {
                    console.log(`[${key}] Ignoring unknown message type from ${senderJid}`);
                }
            }
        }
    } catch (error) {
        console.error('Error in bot logic:', error);
    }
});

// Root endpoint (Upgraded to show instance webhooks)
app.get('/', (req, res) => {
    res.json({
        message: 'WhatsApp API Wrapper is running!',
        instances: Array.from(global.instances.entries()).map(([key, instance]) => ({
            key: key,
            status: instance.status,
            webhookUrl: instance.webhookUrl || 'Not set', // Show the webhook URL
        })),
    });
});

app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    console.log('API is ready to use!');
    console.log('Webhook Tester is active at http://localhost:3000/webhook-tester');
});

