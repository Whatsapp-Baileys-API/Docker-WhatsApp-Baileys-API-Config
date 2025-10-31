import { Router } from 'express';
// --- THIS IS THE FIX for 'default' error ---
// We use a "named import" { Instance } to match our "named export"
import { Instance } from '../core/instance.js'; 
import qrcode from 'qrcode';

const router = Router();

// Get all instances (just for info)
router.get('/', (req, res) => {
    const instances = Array.from(global.instances.keys());
    res.json({ instances });
});

// Create a new instance
router.post('/create', async (req, res) => {
    const { key, webhookUrl } = req.body;
    
    if (!key) {
        return res.status(400).json({ message: 'Instance key is required' });
    }
    if (global.instances.has(key)) {
        return res.status(409).json({ message: 'Instance key already exists' });
    }

    console.log(`Creating instance: ${key}`);
    try {
        // --- THIS IS THE FIX for 'init' error ---
        // The constructor now handles all initialization.
        // We no longer call `instance.init()`
        // The constructor is now synchronous, but we need to call an async init method.
        const instance = new Instance(key, webhookUrl);
        await instance.init(); // This is the crucial change
        
        global.instances.set(key, instance);
        
        res.status(201).json({ 
            message: 'Instance created successfully',
            key: instance.key,
            status: instance.status,
            webhookUrl: instance.webhookUrl
        });
    } catch (error) {
        console.error(`Error creating instance ${key}:`, error);
        res.status(500).json({ message: 'Error creating instance', error: error.message });
    }
});

// Get instance status
router.get('/status/:key', (req, res) => {
    const { key } = req.params;
    const instance = global.instances.get(key);

    if (!instance) {
        return res.status(404).json({ message: 'Instance not found' });
    }

    res.json({ 
        key: instance.key,
        status: instance.status
    });
});

// Get instance QR code
router.get('/qr/:key', async (req, res) => {
    const { key } = req.params;
    const instance = global.instances.get(key);

    if (!instance) {
        return res.status(404).json({ message: 'Instance not found' });
    }

    if (instance.status !== 'qr') {
        return res.status(400).json({ message: `Instance is not awaiting QR. Status: ${instance.status}` });
    }
    
    try {
        // Generate QR as a Data URL (for browsers)
        const qrImage = await qrcode.toDataURL(instance.qr);
        // Send an HTML page that displays the image
        res.send(`
            <html lang="en">
                <head><title>Scan QR Code</title></head>
                <body style="display:flex; justify-content:center; align-items:center; flex-direction:column; font-family:sans-serif;">
                    <h1>Scan QR Code for Instance: ${key}</h1>
                    <img src="${qrImage}" alt="QR Code">
                    <p>Status: ${instance.status}</p>
                </body>
            </html>
        `);
    } catch (error) {
        console.error(`[${key}] Error generating QR code image:`, error);
        res.status(500).json({ message: 'Error generating QR code' });
    }
});

// Delete an instance
router.delete('/delete/:key', async (req, res) => {
    const { key } = req.params;
    const instance = global.instances.get(key);

    if (!instance) {
        return res.status(404).json({ message: 'Instance not found' });
    }

    try {
        await instance.cleanup(); // This disconnects and deletes session from DB
        global.instances.delete(key);
        res.json({ message: 'Instance deleted successfully' });
    } catch (error) {
        console.error(`[${key}] Error deleting instance:`, error);
        res.status(500).json({ message: 'Error deleting instance' });
    }
});

export default router;

