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
import { createRequire } from 'module';

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

// Audience links point at a room through a random id, so the room name never appears in them.
// Added after release: migrate databases created without the column.
if (!db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === 'audience_id')) {
    db.exec('ALTER TABLE rooms ADD COLUMN audience_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rooms_audience_id ON rooms (audience_id)');

// Disappearing chat (the 1 min / 10 min timers) became opt-in per room; by default chat, files
// and polls stay until everyone has left. Added after release, like audience_id.
if (!db.prepare('PRAGMA table_info(rooms)').all().some(c => c.name === 'disappearing')) {
    db.exec('ALTER TABLE rooms ADD COLUMN disappearing INTEGER NOT NULL DEFAULT 0');
}

// Polls in the chat. Votes are keyed by the name people joined with, like everything else in a
// room; names are not verified. version counts votes, so clients keep the newest tally.
db.exec(`
    CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        room_name TEXT,
        creator TEXT,
        question TEXT,
        options TEXT,
        multi INTEGER,
        show_names INTEGER,
        closed INTEGER DEFAULT 0,
        version INTEGER DEFAULT 0,
        created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
        poll_id TEXT,
        voter TEXT,
        choices TEXT,
        created_at INTEGER,
        PRIMARY KEY (poll_id, voter)
    );
`);

// Multer 200MB file limit
const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(compression());
// The client sends JSON as text/plain to avoid CORS preflights (see public/js/api.js).
app.use(express.json({ type: ['application/json', 'text/plain'] }));

// Corporate web gateways can bounce API calls through their own host and back to this one. The
// browser then treats the returning request as cross-origin, sending "Origin: null" (or this
// site's origin), and only hands the response to the page if it is explicitly allowed. The API
// uses no cookies or other ambient credentials, so allowing these origins exposes nothing that
// a direct request could not already get.
app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    let allowed = origin === 'null';
    if (origin && !allowed) {
        try { allowed = new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch (e) {}
    }
    if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Access-Control-Max-Age', '600');
            return res.sendStatus(204);
        }
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
        // File names are not content-hashed, so every asset revalidates (cheap 304s via ETag).
        // A max-age here would let fresh HTML run against stale JS for up to that long after a deploy.
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

// LiveKit's browser client, served from this origin instead of a public CDN: corporate
// firewalls often block CDNs, and the version stays pinned by package.json.
// ("require" resolves to the UMD build, which defines window.LivekitClient.)
const livekitClientPath = createRequire(import.meta.url).resolve('livekit-client');
app.get('/vendor/livekit-client.umd.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(livekitClientPath);
});

// Background blur and virtual backgrounds, same reasoning: LiveKit's processor and MediaPipe's
// segmenter (ES modules, mapped by the import map in index.html) plus MediaPipe's WebAssembly
// runtime. Only fetched once someone picks a background effect.
const requireFromHere = createRequire(import.meta.url);
const trackProcessorsDir = path.dirname(requireFromHere.resolve('@livekit/track-processors'));
const tasksVisionDir = path.dirname(requireFromHere.resolve('@mediapipe/tasks-vision'));
app.get('/vendor/track-processors.mjs', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(trackProcessorsDir, 'index.mjs'));
});
app.get('/vendor/tasks-vision/vision_bundle.mjs', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(tasksVisionDir, 'vision_bundle.mjs'));
});
app.use('/vendor/tasks-vision/wasm', express.static(path.join(tasksVisionDir, 'wasm'), {
    setHeaders(res) { res.setHeader('Cache-Control', 'no-cache'); }
}));

// Hash helper
function hashPassword(pass) {
    return crypto.createHash('sha256').update(pass).digest('hex');
}

function cleanRoomName(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
}

// Disappearing rooms: chat lasts 1 minute, files 10 minutes.
const CHAT_TTL_MS = 60 * 1000;
const FILE_TTL_MS = 10 * 60 * 1000;
// Everything else is kept while anyone is in the room and removed once it has been empty this
// long. The grace covers reloads and reconnects, and LiveKit reporting a leave late.
const EMPTY_GRACE_MS = 2 * 60 * 1000;
// Backstop for a room that never empties (or whose emptiness LiveKit can't tell us)
const MAX_KEEP_MS = 24 * 60 * 60 * 1000;

function isDisappearing(roomName) {
    return !!db.prepare('SELECT disappearing FROM rooms WHERE name = ?').get(roomName)?.disappearing;
}

const MAX_MESSAGE_CHARS = 4000;
const POLL_MAX_OPTIONS = 10;
const POLL_MAX_TEXT = 200;

// A poll as clients see it. Voter names only when the creator chose to show them; everyone gets
// their own choices back so they can see and change their vote.
function pollView(poll, viewer) {
    const options = JSON.parse(poll.options);
    const votes = db.prepare('SELECT voter, choices FROM poll_votes WHERE poll_id = ? ORDER BY created_at ASC').all(poll.id);
    const counts = options.map(() => 0);
    const names = options.map(() => []);
    let mine = null;
    for (const v of votes) {
        const choices = JSON.parse(v.choices);
        for (const i of choices) {
            counts[i]++;
            names[i].push(v.voter);
        }
        if (viewer && v.voter === viewer) mine = choices;
    }
    return {
        id: poll.id,
        room_name: poll.room_name,
        creator: poll.creator,
        question: poll.question,
        options,
        multi: !!poll.multi,
        show_names: !!poll.show_names,
        closed: !!poll.closed,
        version: poll.version,
        created_at: poll.created_at,
        voters: votes.length,
        counts,
        names: poll.show_names ? names : null,
        mine
    };
}

// Audience members join hidden and listen-only: they cannot publish media or data,
// and the people in the room do not see them as participants.
async function issueAudienceToken(audienceId, clientId, res) {
    const room = db.prepare('SELECT name FROM rooms WHERE audience_id = ?').get(String(audienceId));
    if (!room) {
        return res.status(404).json({ error: 'AUDIENCE_LINK_INVALID' });
    }
    db.prepare('UPDATE rooms SET updated_at = ? WHERE name = ?').run(Date.now(), room.name);

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: `listener_${crypto.randomBytes(6).toString('hex')}`,
        name: 'Listener'
    });
    at.addGrant({
        roomJoin: true,
        room: room.name,
        canPublish: false,
        canPublishData: false,
        canSubscribe: true,
        hidden: true
    });

    if (clientId) {
        db.prepare('INSERT OR IGNORE INTO users_alltime (identity, name, room_name, created_at) VALUES (?, ?, ?, ?)').run(
            `cid:${clientId}`, 'Listener', room.name, Date.now()
        );
    }

    res.json({ token: await at.toJwt(), serverUrl: LIVEKIT_URL, audience: true });
}

// Token & room gateway
app.post('/api/token', async (req, res) => {
    try {
        const { roomName, nickname, password, clientId, audienceId } = req.body;
        if (audienceId) {
            return await issueAudienceToken(audienceId, clientId, res);
        }
        if (!roomName || !nickname) {
            return res.status(400).json({ error: 'Room name and nickname required' });
        }

        const cleanRoom = cleanRoomName(roomName);
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

        // Tells the client whether a password belongs in the links it shares.
        const isProtected = !!(existingRoom ? existingRoom.password_hash : password);
        res.json({ token: jwtToken, serverUrl: LIVEKIT_URL, protected: isProtected, disappearing: isDisappearing(cleanRoom) });
    } catch (err) {
        console.error('[Token Generation Error]', err);
        res.status(500).json({ error: 'Failed to generate connection token' });
    }
});

// Audience link: returns the room's audience id, creating it on first use.
// Same check as joining, so only people who may enter the room can hand out listen-only access.
app.post('/api/rooms/:roomName/audience-link', (req, res) => {
    const roomName = cleanRoomName(req.params.roomName);
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(roomName);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    if (room.password_hash && hashPassword(String(req.body?.password || '')) !== room.password_hash) {
        return res.status(401).json({ error: 'Incorrect Password' });
    }

    let audienceId = room.audience_id;
    if (!audienceId) {
        audienceId = crypto.randomBytes(12).toString('base64url');
        db.prepare('UPDATE rooms SET audience_id = ? WHERE name = ?').run(audienceId, roomName);
    }
    res.json({ audienceId });
});

// Room sync for people who join: the chat, files and polls still there
app.get('/api/rooms/:roomName/sync', (req, res) => {
    const roomName = cleanRoomName(req.params.roomName);
    const now = Date.now();
    const disappearing = isDisappearing(roomName);
    const chatSince = disappearing ? now - CHAT_TTL_MS : 0;
    const filesSince = disappearing ? now - FILE_TTL_MS : 0;

    const messages = db.prepare('SELECT id, room_name, sender, text, created_at FROM messages WHERE room_name = ? AND created_at >= ? ORDER BY created_at ASC').all(roomName, chatSince);
    const files = db.prepare('SELECT id, room_name, sender, original_name, size, created_at FROM files WHERE room_name = ? AND created_at >= ? ORDER BY created_at ASC').all(roomName, filesSince);
    const viewer = String(req.query.viewer || '');
    const polls = db.prepare('SELECT * FROM polls WHERE room_name = ? ORDER BY created_at ASC').all(roomName).map(p => pollView(p, viewer));

    res.json({ messages, files, polls, disappearing });
});

// Turns disappearing chat on or off for the room. Same check as joining.
app.post('/api/rooms/:roomName/settings', (req, res) => {
    const roomName = cleanRoomName(req.params.roomName);
    const room = db.prepare('SELECT * FROM rooms WHERE name = ?').get(roomName);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }
    if (room.password_hash && hashPassword(String(req.body?.password || '')) !== room.password_hash) {
        return res.status(401).json({ error: 'Incorrect Password' });
    }
    if (typeof req.body?.disappearing !== 'boolean') {
        return res.status(400).json({ error: 'disappearing must be true or false' });
    }
    db.prepare('UPDATE rooms SET disappearing = ?, updated_at = ? WHERE name = ?').run(req.body.disappearing ? 1 : 0, Date.now(), roomName);
    res.json({ disappearing: req.body.disappearing });
});

// Starts a poll: a question, 2 to 10 options, single or multiple choice, with or without names
app.post('/api/rooms/:roomName/polls', (req, res) => {
    const roomName = cleanRoomName(req.params.roomName);
    const { creator, question, options, multi, showNames } = req.body || {};
    const cleanQuestion = String(question || '').trim().slice(0, POLL_MAX_TEXT);
    const cleanOptions = Array.isArray(options)
        ? options.map(o => String(o || '').trim().slice(0, POLL_MAX_TEXT)).filter(Boolean)
        : [];
    if (!cleanQuestion || cleanOptions.length < 2 || cleanOptions.length > POLL_MAX_OPTIONS) {
        return res.status(400).json({ error: `A question and 2 to ${POLL_MAX_OPTIONS} options are required` });
    }

    const poll = {
        id: crypto.randomUUID(),
        room_name: roomName,
        creator: String(creator || 'Attendee'),
        question: cleanQuestion,
        options: JSON.stringify(cleanOptions),
        multi: multi ? 1 : 0,
        show_names: showNames === false ? 0 : 1,
        closed: 0,
        version: 0,
        created_at: Date.now()
    };
    db.prepare('INSERT INTO polls (id, room_name, creator, question, options, multi, show_names, closed, version, created_at) VALUES (@id, @room_name, @creator, @question, @options, @multi, @show_names, @closed, @version, @created_at)').run(poll);
    res.json(pollView(poll, poll.creator));
});

// Votes, or changes a vote. An empty choice list takes the vote back.
app.post('/api/polls/:pollId/vote', (req, res) => {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(req.params.pollId);
    if (!poll) {
        return res.status(404).json({ error: 'Poll not found' });
    }
    if (poll.closed) {
        return res.status(409).json({ error: 'Poll is closed' });
    }
    const voter = String(req.body?.voter || '').trim();
    const count = JSON.parse(poll.options).length;
    const choices = Array.isArray(req.body?.choices)
        ? [...new Set(req.body.choices.map(Number))].filter(i => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b)
        : [];
    if (!voter || (!poll.multi && choices.length > 1)) {
        return res.status(400).json({ error: 'A name and a valid choice are required' });
    }

    db.transaction(() => {
        if (choices.length) {
            db.prepare('INSERT INTO poll_votes (poll_id, voter, choices, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (poll_id, voter) DO UPDATE SET choices = excluded.choices').run(poll.id, voter, JSON.stringify(choices), Date.now());
        } else {
            db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND voter = ?').run(poll.id, voter);
        }
        db.prepare('UPDATE polls SET version = version + 1 WHERE id = ?').run(poll.id);
    })();
    res.json(pollView(db.prepare('SELECT * FROM polls WHERE id = ?').get(poll.id), voter));
});

// Ends a poll; only the person who started it (by name)
app.post('/api/polls/:pollId/close', (req, res) => {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(req.params.pollId);
    if (!poll) {
        return res.status(404).json({ error: 'Poll not found' });
    }
    if (String(req.body?.creator || '') !== poll.creator) {
        return res.status(403).json({ error: 'Only the person who started the poll can close it' });
    }
    db.prepare('UPDATE polls SET closed = 1, version = version + 1 WHERE id = ?').run(poll.id);
    res.json(pollView(db.prepare('SELECT * FROM polls WHERE id = ?').get(poll.id), poll.creator));
});

// Save a chat message
app.post('/api/rooms/:roomName/chat', (req, res) => {
    const roomName = req.params.roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const { sender } = req.body;
    // Leading spaces stay (pasted code); blank lines around the message go. Capped so the
    // message still fits in one reliable LiveKit data packet.
    const text = String(req.body.text || '').replace(/^\s*\n|\s+$/g, '').slice(0, MAX_MESSAGE_CHARS);

    if (!text.trim()) {
        return res.status(400).json({ error: 'Message text required' });
    }

    const now = Date.now();
    const id = crypto.randomUUID();

    db.prepare('INSERT INTO messages (id, room_name, sender, text, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        roomName,
        sender || 'Attendee',
        text,
        now
    );

    res.json({ id, room_name: roomName, sender: sender || 'Attendee', text, created_at: now });
});

// Upload a file (200MB limit)
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

function deleteFiles(rows) {
    for (const f of rows) {
        const p = path.join(uploadDir, f.stored_filename);
        if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch (e) {}
        }
    }
}

// Chat, files and polls of a room, all at once
function purgeRoomContent(roomName) {
    deleteFiles(db.prepare('SELECT stored_filename FROM files WHERE room_name = ?').all(roomName));
    db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE room_name = ?').run(roomName);
        db.prepare('DELETE FROM files WHERE room_name = ?').run(roomName);
        db.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE room_name = ?)').run(roomName);
        db.prepare('DELETE FROM polls WHERE room_name = ?').run(roomName);
    })();
}

// Rooms with content that LiveKit last saw empty, and since when
const emptySince = new Map();
let purgeRunning = false;

// Background purge worker (every 10 seconds)
setInterval(async () => {
    if (purgeRunning) return;
    purgeRunning = true;
    try {
        const now = Date.now();

        // 1. Disappearing rooms: chat after 1 minute, files after 10 minutes
        db.prepare('DELETE FROM messages WHERE created_at < ? AND room_name IN (SELECT name FROM rooms WHERE disappearing = 1)').run(now - CHAT_TTL_MS);
        const fileTtlQuery = 'FROM files WHERE created_at < ? AND room_name IN (SELECT name FROM rooms WHERE disappearing = 1)';
        deleteFiles(db.prepare(`SELECT stored_filename ${fileTtlQuery}`).all(now - FILE_TTL_MS));
        db.prepare(`DELETE ${fileTtlQuery}`).run(now - FILE_TTL_MS);

        // 2. Every room: everything goes once nobody has been in it for the grace period.
        // If LiveKit can't be asked, nothing is removed on that account.
        const withContent = db.prepare('SELECT room_name FROM messages UNION SELECT room_name FROM files UNION SELECT room_name FROM polls').all().map(r => r.room_name);
        if (withContent.length) {
            let occupied = null;
            try {
                occupied = new Set((await roomService.listRooms([])).filter(r => r.numParticipants > 0).map(r => r.name));
            } catch (err) {
                console.error('[Purge] LiveKit unreachable, keeping room content:', err.message);
            }
            if (occupied) {
                for (const name of withContent) {
                    if (occupied.has(name)) {
                        emptySince.delete(name);
                    } else if (!emptySince.has(name)) {
                        emptySince.set(name, now);
                    } else if (now - emptySince.get(name) >= EMPTY_GRACE_MS) {
                        purgeRoomContent(name);
                        emptySince.delete(name);
                    }
                }
                for (const name of emptySince.keys()) {
                    if (!withContent.includes(name)) emptySince.delete(name);
                }
            }
        }

        // 3. Backstop: nothing is kept longer than a day
        db.prepare('DELETE FROM messages WHERE created_at < ?').run(now - MAX_KEEP_MS);
        deleteFiles(db.prepare('SELECT stored_filename FROM files WHERE created_at < ?').all(now - MAX_KEEP_MS));
        db.prepare('DELETE FROM files WHERE created_at < ?').run(now - MAX_KEEP_MS);
        db.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE created_at < ?)').run(now - MAX_KEEP_MS);
        db.prepare('DELETE FROM polls WHERE created_at < ?').run(now - MAX_KEEP_MS);

        // 4. Purge inactive rooms older than 7 days
        db.prepare('DELETE FROM rooms WHERE updated_at < ?').run(now - 7 * 24 * 60 * 60 * 1000);
    } catch (err) {
        console.error('[Purge] failed:', err);
    } finally {
        purgeRunning = false;
    }
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
