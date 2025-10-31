import express from 'express';
import multer from 'multer';
import fs from 'fs'; // We need 'fs' to delete temp files
import path from 'path';

const router = express.Router();
// Set up multer's temporary upload folder and ensure it exists
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({ dest: uploadDir });

// --- Button 1: Send a Text Message ---
router.post('/send/text', async (req, res) => {
    // We need: key, to, message
    const { key, to, message } = req.body;

    if (!key || !to || !message) {
        return res.status(400).json({ error: 'Missing required fields: key, to, message' });
    }

    const instance = global.instances.get(key);
    if (!instance) {
        return res.status(404).json({ error: 'Instance not found' });
    }

    if (instance.status !== 'connected') {
        return res.status(400).json({ error: 'Instance is not connected' });
    }

    try {
        // This is where we use the function we built into our 'instance.js'
        const sentMsg = await instance.sendText(to, message);
        res.status(200).json({
            success: true,
            message: 'Text message sent',
            data: sentMsg,
        });
    } catch (error) {
        console.error(`[${key}] Error sending text:`, error);
        res.status(500).json({ error: 'Failed to send text message' });
    }
});

// --- Button 2: Send a Media Message (Image, Video, Doc, Audio) ---
// We use 'upload.single('file')' to handle the file upload
router.post('/send/media', upload.single('file'), async (req, res) => {
    // We need: key, to, caption, and the file itself
    const { key, to, caption } = req.body;
    const file = req.file; // This is the uploaded file

    if (!key || !to || !file) {
        return res.status(400).json({ error: 'Missing required fields: key, to, file' });
    }

    const instance = global.instances.get(key);
    if (!instance) {
        // Clean up the uploaded file if instance not found
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        return res.status(404).json({ error: 'Instance not found' });
    }

    if (instance.status !== 'connected') {
        // Clean up the uploaded file
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        return res.status(400).json({ error: 'Instance is not connected' });
    }

    try {
        // Determine media type (image, video, document, audio)
        let type = 'document'; // Default
        if (file.mimetype.startsWith('image/')) {
            type = 'image';
        } else if (file.mimetype.startsWith('video/')) {
            type = 'video';
        } else if (file.mimetype.startsWith('audio/')) {
            type = 'audio';
        }

        // This is where we use the sendMedia function from 'instance.js'
        const sentMsg = await instance.sendMedia(
            to,
            file.path, // Pass the path to the temp file
            caption || '',
            type,
            file.originalname // Pass the original filename
        );

        // --- CRITICAL: Clean up the temp file after sending ---
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }

        res.status(200).json({
            success: true,
            message: `${type} message sent`,
            data: sentMsg,
        });
    } catch (error) {
        console.error(`[${key}] Error sending media:`, error);
        // Clean up the temp file if an error occurs
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        res.status(500).json({ error: 'Failed to send media message' });
    }
});

export default router;

