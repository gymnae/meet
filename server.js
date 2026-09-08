const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const db = new Database('portal.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
        room_name TEXT PRIMARY KEY,
        password_hash TEXT,
        last_accessed INTEGER
    )
`);

function hashPassword(password) {
    if (!password) return null;
    return crypto.createHash('sha256').update(password).digest('hex');
}

// 7-Day Automated Stale Room Cleanup Job
setInterval(() => {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const result = db.prepare('DELETE FROM rooms WHERE last_accessed < ?').run(sevenDaysAgo);
    if (result.changes > 0) {
        console.log(`[Database] Auto-purged ${result.changes} stale room(s) inactive for >7 days.`);
    }
}, 3600000);

app.post('/api/token', async (req, res) => {
    const { roomName, nickname, password } = req.body;
    if (!roomName || !nickname) {
        return res.status(400).json({ error: 'Room name and nickname are required.' });
    }

    const cleanRoom = roomName.toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const now = Date.now();
    const inputHash = hashPassword(password);

    const existingRoom = db.prepare('SELECT * FROM rooms WHERE room_name = ?').get(cleanRoom);

    if (existingRoom) {
        if (existingRoom.password_hash) {
            // === NEW: Explicit flag to trigger the frontend UI reveal ===
            if (!inputHash) {
                return res.status(401).json({ error: 'This room is protected.', requiresPassword: true });
            }
            if (inputHash !== existingRoom.password_hash) {
                return res.status(401).json({ error: 'Incorrect password.' });
            }
        }
        db.prepare('UPDATE rooms SET last_accessed = ? WHERE room_name = ?').run(now, cleanRoom);
    } else {
        db.prepare('INSERT INTO rooms (room_name, password_hash, last_accessed) VALUES (?, ?, ?)').run(cleanRoom, inputHash, now);
    }

    const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
    const serverUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';

    const at = new AccessToken(apiKey, apiSecret, {
        identity: `${nickname}_${Math.random().toString(36).substring(2, 7)}`,
        name: nickname,
    });
    at.addGrant({ roomJoin: true, room: cleanRoom, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    res.json({ serverUrl, token });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Portal] Server running on port ${PORT}`));
