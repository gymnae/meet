import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import compression from 'compression';
import Database from 'better-sqlite3';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Environment credentials
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';

// LiveKit Room Service for live presence stats (ws:// -> http://)
const LIVEKIT_HTTP_URL = (process.env.LIVEKIT_HTTP_URL || LIVEKIT_URL.replace(/^ws/, 'http'));
const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// Persistent data directory (bind-mount a host folder here in Docker)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure uploads folder exists
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Sound board library, from one of two sources:
// - SOUNDBOARD_URL: a running Mumble Retro Soundboard (/api/sounds, /sounds/<file>).
//   Its files are passed through this server, so browsers never talk to it directly.
//   Credentials in the URL (https://user:pass@host) are sent as Basic auth.
// - SOUNDS_DIR: a flat folder of audio files, e.g. the soundboard's sounds folder
//   mounted read-only. A missing folder just means no sound board.
const SOUNDS_DIR = process.env.SOUNDS_DIR || path.join(__dirname, 'sounds');
const SOUND_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);
// Every listener downloads and decodes a sound in full, so long tracks are left out.
const SOUND_MAX_BYTES = (Number(process.env.SOUNDS_MAX_MB) || 3) * 1024 * 1024;
const SOUNDBOARD = parseSoundboardUrl(process.env.SOUNDBOARD_URL);
const SOUNDBOARD_LIST_TTL = 60 * 1000;
const SOUNDBOARD_RETRY = 10 * 1000;

function parseSoundboardUrl(raw) {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        const headers = {};
        if (url.username || url.password) {
            const auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
            headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
            url.username = url.password = '';
        }
        return { base: url.href.replace(/\/+$/, ''), headers };
    } catch (e) {
        console.error('[Sounds] Ignoring invalid SOUNDBOARD_URL');
        return null;
    }
}

function isSoundName(name) {
    return typeof name === 'string' && !name.startsWith('.') && !/[\\/]/.test(name) &&
        SOUND_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function sortSounds(names) {
    return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

function listFolderSounds() {
    let entries;
    try {
        entries = fs.readdirSync(SOUNDS_DIR, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    return sortSounds(entries
        .filter(e => e.isFile() && isSoundName(e.name))
        .filter(e => {
            try { return fs.statSync(path.join(SOUNDS_DIR, e.name)).size <= SOUND_MAX_BYTES; }
            catch (err) { return false; }
        })
        .map(e => e.name));
}

function soundboardFetch(pathname, headers = {}) {
    return fetch(`${SOUNDBOARD.base}${pathname}`, {
        headers: { ...SOUNDBOARD.headers, ...headers },
        signal: AbortSignal.timeout(30 * 1000)
    });
}

// Cached list from the soundboard. If it is unreachable, the last list stays in use.
const soundboardList = { names: [], fetchedAt: 0, pending: null };
async function listSoundboardSounds() {
    if (Date.now() - soundboardList.fetchedAt < SOUNDBOARD_LIST_TTL) return soundboardList.names;
    if (!soundboardList.pending) {
        soundboardList.pending = soundboardFetch('/api/sounds')
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => {
                const sounds = Array.isArray(data?.sounds) ? data.sounds : [];
                soundboardList.names = sortSounds(sounds
                    .filter(s => isSoundName(s?.name) && !(s.size > SOUND_MAX_BYTES))
                    .map(s => s.name));
                soundboardList.fetchedAt = Date.now();
            })
            .catch(err => {
                console.error('[Sounds] Soundboard unreachable:', err.message);
                soundboardList.fetchedAt = Date.now() - SOUNDBOARD_LIST_TTL + SOUNDBOARD_RETRY;
            })
            .finally(() => { soundboardList.pending = null; });
    }
    await soundboardList.pending;
    return soundboardList.names;
}

function listSounds() {
    return SOUNDBOARD ? listSoundboardSounds() : Promise.resolve(listFolderSounds());
}

// Database setup (stored in the data dir so it survives container recreation)
const db = new Database(path.join(DATA_DIR, 'portal.db'));
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

    CREATE TABLE IF NOT EXISTS channels_alltime (
        name TEXT PRIMARY KEY,
        created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS users_alltime (
        identity TEXT PRIMARY KEY,
        name TEXT,
        room_name TEXT,
        created_at INTEGER
    );
`);

// Multer 200MB file limit
const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
        // File names are not content-hashed, so every asset revalidates (cheap 304s via ETag).
        // A max-age here would let fresh HTML run against stale JS for up to that long after a deploy.
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

// Hash helper
function hashPassword(pass) {
    return crypto.createHash('sha256').update(pass).digest('hex');
}

// Token & room gateway
app.post('/api/token', async (req, res) => {
    try {
        const { roomName, nickname, password, clientId } = req.body;
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
            // Track all-time channel count (rooms table is purged after 7 days)
            db.prepare('INSERT OR IGNORE INTO channels_alltime (name, created_at) VALUES (?, ?)').run(cleanRoom, now);
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

        // Track all-time unique users.
        // Prefer the persistent anonymous clientId sent by the client
        // (survives reconnects, independent of username). Fallback: hash
        // of the nickname, so the same username isn't double-counted.
        const uniqueKey = clientId
            ? `cid:${clientId}`
            : `name:${crypto.createHash('sha256').update(String(nickname).toLowerCase()).digest('hex').slice(0, 16)}`;

        db.prepare('INSERT OR IGNORE INTO users_alltime (identity, name, room_name, created_at) VALUES (?, ?, ?, ?)').run(
            uniqueKey,
            nickname,
            cleanRoom,
            now
        );

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

// Sound board library
app.get('/api/sounds', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ sounds: await listSounds() });
});

app.get('/api/sounds/:file', async (req, res) => {
    const name = req.params.file;
    if (!(await listSounds()).includes(name)) {
        return res.status(404).send('Sound not found.');
    }
    res.setHeader('Cache-Control', 'no-cache');
    if (!SOUNDBOARD) {
        return res.sendFile(name, { root: SOUNDS_DIR, dotfiles: 'deny' });
    }

    try {
        const conditional = {};
        ['if-none-match', 'if-modified-since'].forEach(h => { if (req.headers[h]) conditional[h] = req.headers[h]; });
        const upstream = await soundboardFetch(`/sounds/${encodeURIComponent(name)}`, conditional);
        if (upstream.status === 304) return res.status(304).end();
        if (!upstream.ok || !upstream.body) {
            return res.status(upstream.status === 404 ? 404 : 502).send('Sound unavailable.');
        }
        ['content-type', 'content-length', 'etag', 'last-modified'].forEach(h => {
            const value = upstream.headers.get(h);
            if (value) res.setHeader(h, value);
        });
        Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
        console.error('[Sounds] Soundboard file failed:', err.message);
        if (!res.headersSent) res.status(502).send('Sound unavailable.');
        else res.destroy();
    }
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

// Status dashboard endpoint
app.get('/api/status', async (req, res) => {
    const totalChannels = db.prepare('SELECT COUNT(*) AS c FROM channels_alltime').get().c;
    const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users_alltime').get().c;

    // All known channels from the database (rooms table = currently known)
    const knownChannels = db.prepare('SELECT name, created_at, updated_at FROM rooms ORDER BY name ASC').all();

    let currentUsers = 0;
    const activeChannelsSet = new Set();
    try {
        const liveRooms = await roomService.listRooms([]);
        for (const room of liveRooms) {
            if (room.numParticipants > 0) {
                activeChannelsSet.add(room.name);
                currentUsers += room.numParticipants;
            }
        }
    } catch (err) {
        console.error('[Status] LiveKit unreachable:', err.message);
    }

    const activeChannels = [...activeChannelsSet].sort().map(name => ({ name }));
    const idleChannels = knownChannels
        .map(r => r.name)
        .filter(name => !activeChannelsSet.has(name));

    res.json({
        currentUsers,
        activeChannels,
        idleChannels,
        totalChannels,
        totalUsers
    });
});

server.listen(PORT, () => {
    console.log(`[meet.] Server running on http://localhost:${PORT}`);
});
