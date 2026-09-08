import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import Database from 'better-sqlite3';
import { AccessToken } from 'livekit-server-sdk';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Environment credentials
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Database setup
const db = new Database('portal.db');
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
        name TEXT PRIMARY KEY,
        password_hash TEXT,
        created_at INTEGER,
        updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_name TEXT,
        sender TEXT,
        text TEXT,
        created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        room_name TEXT,
        sender TEXT,
        original_name TEXT,
        stored_filename TEXT,
        size INTEGER,
        created_at INTEGER
    );
`);

// Multer 200MB file limit
const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Hash helper
function hashPassword(pass) {
    return crypto.createHash('sha256').update(pass).digest('hex');
}

// Token & room gateway
app.post('/api/token', async (req, res) => {
    try {
        const { roomName, nickname, password } = req.body;
        if (!roomName || !nickname) {
            return res.status(400).json({ error: 'Room name and nickname required' });
        }

        const cleanRoom = roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
        const now = Date.now();

        const existingRoom = db.prepare('SELECT * FROM rooms WHERE name = ?').get(cleanRoom);

        if (existingRoom && existingRoom.password_hash) {
            if (!password) {
                return res.json({ requiresPassword: true });
            }
            if (hashPassword(password) !== existingRoom.password_hash) {
                return res.status(401).json({ error: 'Incorrect Password' });
            }
            db.prepare('UPDATE rooms SET updated_at = ? WHERE name = ?').run(now, cleanRoom);
        } else if (!existingRoom) {
            const passwordHash = password ? hashPassword(password) : null;
            db.prepare('INSERT INTO rooms (name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
                cleanRoom,
                passwordHash,
                now,
                now
            );
        } else {
            db.prepare('UPDATE rooms SET updated_at = ? WHERE name = ?').run(now, cleanRoom);
        }

        const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: `${nickname}_${crypto.randomBytes(4).toString('hex')}`,
            name: nickname
        });

        at.addGrant({
            roomJoin: true,
            room: cleanRoom,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        });

        // Await the asynchronous JWT generation required by livekit-server-sdk v2
        const jwtToken = await at.toJwt();

        res.json({ token: jwtToken, serverUrl: LIVEKIT_URL });
    } catch (err) {
        console.error('[Token Generation Error]', err);
        res.status(500).json({ error: 'Failed to generate connection token' });
    }
});

// Ephemeral room sync (chat messages <60s, files <10m)
app.get('/api/rooms/:roomName/sync', (req, res) => {
    const roomName = req.params.roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const now = Date.now();

    const messages = db.prepare('SELECT id, room_name, sender, text, created_at FROM messages WHERE room_name = ? AND created_at >= ? ORDER BY created_at ASC').all(roomName, now - 60 * 1000);
    const files = db.prepare('SELECT id, room_name, sender, original_name, size, created_at FROM files WHERE room_name = ? AND created_at >= ? ORDER BY created_at ASC').all(roomName, now - 10 * 60 * 1000);

    res.json({ messages, files });
});

// Save ephemeral message (1-minute TTL)
app.post('/api/rooms/:roomName/chat', (req, res) => {
    const roomName = req.params.roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const { sender, text } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Message text required' });
    }

    const now = Date.now();
    const id = crypto.randomUUID();

    db.prepare('INSERT INTO messages (id, room_name, sender, text, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        roomName,
        sender || 'Attendee',
        text.trim(),
        now
    );

    res.json({ id, room_name: roomName, sender: sender || 'Attendee', text: text.trim(), created_at: now });
});

// Upload ephemeral file (200MB limit, 10-minute TTL)
app.post('/api/rooms/:roomName/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'File exceeds 200MB limit' });
            }
            return res.status(400).json({ error: err.message });
        } else if (err) {
            return res.status(500).json({ error: 'Upload failed' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const roomName = req.params.roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
        const sender = req.body.sender || 'Attendee';
        const now = Date.now();
        const id = crypto.randomUUID();

        db.prepare('INSERT INTO files (id, room_name, sender, original_name, stored_filename, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            id,
            roomName,
            sender,
            req.file.originalname,
            req.file.filename,
            req.file.size,
            now
        );

        res.json({
            id,
            room_name: roomName,
            sender,
            original_name: req.file.originalname,
            size: req.file.size,
            created_at: now
        });
    });
});

// Download file endpoint
app.get('/api/files/:fileId', (req, res) => {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.fileId);
    if (!file) {
        return res.status(404).send('File expired or deleted.');
    }

    const filePath = path.join(uploadDir, file.stored_filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('File not found on storage.');
    }

    res.download(filePath, file.original_name);
});

// Background Auto-Purge Worker (Every 10 seconds)
setInterval(() => {
    const now = Date.now();

    // 1. Purge chat older than 60 seconds
    db.prepare('DELETE FROM messages WHERE created_at < ?').run(now - 60 * 1000);

    // 2. Purge files older than 10 minutes (600 seconds)
    const expiredFiles = db.prepare('SELECT id, stored_filename FROM files WHERE created_at < ?').all(now - 10 * 60 * 1000);
    for (const f of expiredFiles) {
        const p = path.join(uploadDir, f.stored_filename);
        if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch (e) {}
        }
    }
    db.prepare('DELETE FROM files WHERE created_at < ?').run(now - 10 * 60 * 1000);

    // 3. Purge inactive rooms older than 7 days
    db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(now - 7 * 24 * 60 * 60 * 1000);
}, 10000);

server.listen(PORT, () => {
    console.log(`[meet.] Server running on http://localhost:${PORT}`);
});
