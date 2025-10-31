import { Router } from 'express';
// --- THIS IS THE FIX for 'default' error ---
// We use a "named import" { Instance } to match our "named export"
import { Instance } from '../core/instance.js'; 
import qrcode from 'qrcode';

const router = Router();

// Get all instances (just for info)
router.get('/', (req, res) => {
    console.log('GET /instance - Request to list all instances');
    const instances = Array.from(global.instances.keys());
    console.log(`GET /instance - Found ${instances.length} instances.`);
    res.json({ instances });
});

// Create a new instance
router.post('/create', async (req, res) => {
    const { key, webhookUrl } = req.body;
    console.log(`POST /instance/create - Request for key: '${key}'`);
    
    if (!key) {
        console.log(`POST /instance/create - Failed: Missing instance key.`);
        return res.status(400).json({ message: 'Instance key is required' });
    }
    if (global.instances.has(key)) {
        console.log(`POST /instance/create - Failed: Instance key '${key}' already exists.`);
        return res.status(409).json({ message: 'Instance key already exists' });
    }

    console.log(`POST /instance/create - Creating new instance for key: '${key}'`);
    try {
        // The constructor is now synchronous, but we need to call an async init method.
        const instance = new Instance(key, webhookUrl);
        await instance.initialize(); // This is the crucial change
        
        global.instances.set(key, instance);
        console.log(`POST /instance/create - Successfully created instance '${key}'.`);
        
        res.status(201).json({ 
            message: 'Instance created successfully',
            key: instance.key,
            status: instance.status,
            webhookUrl: instance.webhookUrl
        });
    } catch (error) {
        console.error(`POST /instance/create - Error creating instance '${key}':`, error);
        res.status(500).json({ message: 'Error creating instance', error: error.message });
    }
});

// Get instance status
router.get('/status/:key', (req, res) => {
    const { key } = req.params;
    console.log(`GET /instance/status/${key} - Request for instance status`);
    const instance = global.instances.get(key);

    if (!instance) {
        console.log(`GET /instance/status/${key} - Failed: Instance not found.`);
        return res.status(404).json({ message: 'Instance not found' });
    }

    res.json({ 
        key: instance.key,
        status: instance.status
    });
    console.log(`GET /instance/status/${key} - Responded with status: '${instance.status}'.`);
});

// Get instance QR code
router.get('/qr/:key', async (req, res) => {
    const { key } = req.params;
    console.log(`GET /instance/qr/${key} - Request for QR code`);
    const instance = global.instances.get(key);

    if (!instance) {
        console.log(`GET /instance/qr/${key} - Failed: Instance not found.`);
        return res.status(404).json({ message: 'Instance not found' });
    }

    if (instance.status !== 'qr') {
        console.log(`GET /instance/qr/${key} - Failed: Instance status is '${instance.status}', not 'qr'.`);
        return res.status(400).json({ message: `Instance is not awaiting QR. Status: ${instance.status}` });
    }
    
    try {
        // Generate QR as a Data URL (for browsers)
        const qrImage = await qrcode.toDataURL(instance.qr);
        // Send an HTML page that displays the image
        console.log(`GET /instance/qr/${key} - Successfully generated and sent QR code image.`);
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
        console.error(`GET /instance/qr/${key} - Error generating QR code image:`, error);
        res.status(500).json({ message: 'Error generating QR code' });
    }
});

// Delete an instance
router.delete('/delete/:key', async (req, res) => {
    const { key } = req.params;
    console.log(`DELETE /instance/delete/${key} - Request to delete instance`);
    const instance = global.instances.get(key);

    if (!instance) {
        console.log(`DELETE /instance/delete/${key} - Failed: Instance not found.`);
        return res.status(404).json({ message: 'Instance not found' });
    }

    try {
        await instance.cleanup(); // This disconnects and deletes session from DB
        global.instances.delete(key);
        console.log(`DELETE /instance/delete/${key} - Successfully deleted instance.`);
        res.json({ message: 'Instance deleted successfully' });
    } catch (error) {
        console.error(`DELETE /instance/delete/${key} - Error deleting instance:`, error);
        res.status(500).json({ message: 'Error deleting instance' });
    }
});

export default router;
