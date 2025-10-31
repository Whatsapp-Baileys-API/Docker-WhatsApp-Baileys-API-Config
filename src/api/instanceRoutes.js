import express from 'express';
import Instance from '../core/instance.js'; 
import qrcode from 'qrcode';

const router = express.Router();

// --- Create a new instance --- (THIS ROUTE IS UPGRADED)
router.post('/create', async (req, res) => {
    // --- 'webhookUrl' is new ---
    const { key, webhookUrl } = req.body; 
    
    if (!key) {
        return res.status(400).json({ error: 'Instance key (key) is required' });
    }

    if (global.instances.has(key)) {
        return res.status(400).json({ error: 'Instance key already exists' });
    }

    try {
        console.log(`Creating instance: ${key}`);
        // --- Pass the webhookUrl to the constructor ---
        const instance = new Instance(key, webhookUrl || null); 
        await instance.init();
        
        global.instances.set(key, instance);
        
        res.status(201).json({
            message: 'Instance created successfully',
            key: key,
            status: instance.status,
            webhookUrl: instance.webhookUrl, // Send back the webhookUrl
        });
    } catch (error) {
        console.error(`Error creating instance ${key}:`, error);
        res.status(500).json({ error: 'Failed to create instance' });
    }
});

// --- Get instance status --- (Unchanged)
router.get('/status/:key', (req, res) => {
    // ... (this route is the same) ...
    const { key } = req.params;
    const instance = global.instances.get(key);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    res.status(200).json({
        key: instance.key,
        status: instance.status,
    });
});

// --- Get instance QR code --- (Unchanged)
router.get('/qr/:key', async (req, res) => {
    // ... (this route is the same) ...
    const { key } = req.params;
    const instance = global.instances.get(key);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    if (instance.status !== 'qr' || !instance.qr) {
        return res.status(400).json({ 
            error: 'QR code not available',
            status: instance.status 
        });
    }

    try {
        const dataUrl = await qrcode.toDataURL(instance.qr);
        res.send(`
            <html style="background-color: #2e2e2e; color: white; text-align: center; font-family: sans-serif;">
                <head><title>Scan QR Code for ${key}</title></head>
                <body style="display: grid; place-items: center; min-height: 100vh;">
                    <div>
                        <h1>Scan QR Code for "${key}"</h1>
                        <p>Scan this with WhatsApp to link your device.</p>
                        <img src="${dataUrl}" alt="QR Code" style="background-color: white; padding: 20px; border-radius: 16px;">
                        <p>Status: ${instance.status}</p>
                    </div>
                </body>
            </html>
        `);
    } catch (err) {
        console.error('Failed to generate QR code data URL', err);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// --- Delete an instance --- (Unchanged)
router.delete('/delete/:key', async (req, res) => {
    // ... (this route is the same) ...
    const { key } = req.params;
    const instance = global.instances.get(key);

    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    try {
        await instance.sock?.logout();
    } catch (error) {
        console.error(`Error logging out instance ${key}:`, error);
    }

    global.instances.delete(key);
    console.log(`Instance ${key} deleted.`);

    res.status(200).json({
        message: 'Instance deleted successfully',
        key: key,
    });
});

export default router;

