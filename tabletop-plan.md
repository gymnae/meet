# meet. Table mode — implementation plan

An optional **Table** mode that turns a room into a virtual tabletop: server-rolled dice, an initiative tracker, scene images, persistent handouts and a basic shared map (image, grid, tokens, pings, measuring). Fog of war, character sheets and rules automation are out of scope. The soundboard is out of scope too, because an external soundboard already connects to meet.

Written against `main` at `6ef1a93`.

---

## 1. Principles

1. **The server is in charge of game state.** Dice, tokens, initiative and scenes change only through the server, which checks who is asking. Clients render what the server says. This is the groundwork for fog of war later.
2. **The server broadcasts, clients don't.** After a change, the server pushes it to the room with `RoomServiceClient.sendData()` (livekit-server-sdk 2.19, already a dependency). Clients accept table packets **only when `participant` is undefined**, which means they came from the server. A client that forges a `TABLE_*` packet is ignored.
3. **Ephemeral stays ephemeral.** Chat (60 s) and files (10 min) keep their TTLs. Table data gets its own tables and its own, longer lifetime.
4. **The table is a tile.** The table stage is a `.video-tile` with the id `tile_table`. When it is open it becomes the maximize target, so the existing layout puts faces in the sidebar (desktop) or the bottom strip (phones) without any new layout code.
5. **No accounts.** The GM role is a secret link, the same idea as audience links.
6. **Follow `design.md`.** Tokens only, 44 px targets, nothing under 14 px, dark ink on neon. Cyan for the engaged Table button, yellow for "whose turn".

---

## 2. Foundation (server)

### 2.1 Room tickets: who is calling the API

Today the REST endpoints don't check who is calling. That is fine for 60-second chat, but not for game state. The fix:

- `/api/token` also returns a **ticket**: `base64url(payload) + '.' + HMAC-SHA256(TICKET_SECRET, payload)`, where the payload is `{ room, identity, clientId, role, exp }`.
  - `role` is `player`, `gm` or `audience`.
  - `exp` is 12 h. The client asks for a new ticket on reconnect (see 2.6).
  - `TICKET_SECRET` comes from an env var. If it is missing, derive it from `LIVEKIT_API_SECRET`, so existing deploys need no new config.
- Audience tokens get an `audience` ticket, which is read-only.
- All `/api/rooms/:room/table*` and `/roll` endpoints need the header `X-Meet-Ticket`. The CORS block (`server.js:106`) must allow that header. The comment in `api.js` explains why the client avoids preflights, so instead the ticket goes **in the JSON body** for POSTs and in a `?t=` query for GETs. That keeps requests "simple".
- Helper: `requireTicket(req, roomName, { write, gm })`. It returns the payload or sends 401/403.

### 2.2 The GM role

- New column `rooms.gm_key_hash` (migration in the same style as `audience_id`).
- `POST /api/rooms/:room/table/enable` with a player ticket. If the room has no table yet, it creates one, makes the caller GM, and returns a `gmKey` (24 random bytes, base64url). If a table already exists, it returns 409.
- GM link: `#room?gm=<key>`, extending `parseInviteHash()` in `share.js`. The client keeps it in `portal_vault` next to the password, so the GM stays GM on rejoin. The key can be shared to add a co-GM.
- `/api/token` takes an optional `gmKey`. If it matches, the ticket role is `gm`, and the LiveKit token gets the attribute `role=gm` so every client can show a GM badge on that tile.
- `POST /api/rooms/:room/table/gm-key/rotate` (GM only) revokes old links.
- The server keeps `gmIdentities: Map<room, Set<identity>>`, filled when GM tickets are issued, for routing secret rolls.

### 2.3 Schema

```sql
CREATE TABLE IF NOT EXISTS tables (
    room_name  TEXT PRIMARY KEY,
    state      TEXT NOT NULL,      -- JSON, see 2.4
    version    INTEGER NOT NULL,   -- increments on every op
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS table_assets (  -- maps, scene images, handouts, token art
    id              TEXT PRIMARY KEY,
    room_name       TEXT NOT NULL,
    kind            TEXT NOT NULL,         -- map | scene | handout | token
    original_name   TEXT,
    stored_filename TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size            INTEGER,
    created_at      INTEGER
);

CREATE TABLE IF NOT EXISTS rolls (
    id         TEXT PRIMARY KEY,
    room_name  TEXT NOT NULL,
    roller     TEXT,             -- display name
    identity   TEXT,
    expr       TEXT,
    result     TEXT,             -- JSON breakdown
    secret     INTEGER DEFAULT 0,
    created_at INTEGER
);
```

- Assets live in `DATA_DIR/table-assets/`, not `uploads/`, so the 10-minute purge never touches them.
- Asset uploads: images only (png, jpeg, webp, gif) plus PDF for handouts, 25 MB each, 300 MB per room. Use a separate `multer` instance.
- `GET /api/table-assets/:id?t=` serves the file inline (not `download`) and checks the ticket's room.

**Lifetime.** A room with a table is kept for **90 days** after the table was last used, instead of 7. The purge worker (`server.js:391`) skips rooms whose `tables.updated_at` is recent, and deletes table, assets and rolls together when the room goes. Rolls older than 30 days are trimmed. Make both numbers constants at the top of the file.

### 2.4 State document

```js
{
  mode: 'scene' | 'map',
  scene:   { assetId, caption },
  map:     { assetId, width, height, grid: { size, offsetX, offsetY, visible, unit: '5 ft' } },
  tokens:  { [id]: { id, x, y, size, label, color, assetId, owner /* clientId or null */, hidden } },
  initiative: { entries: [{ id, name, value, tokenId, owner }], turn: 0, round: 1, active: false },
  handouts:   [{ assetId, title, sharedAt }]   // only shared ones; GM-only drafts are just assets
}
```

`hidden` tokens are left out of the snapshot and the broadcast for non-GM tickets. That is the only per-viewer filtering in this slice, and it uses the same code path fog of war will need.

### 2.5 Ops and sync

- `GET /api/rooms/:room/table?t=` returns `{ enabled, version, state, recentRolls }`, filtered for the ticket's role.
- `POST /api/rooms/:room/table/op` with body `{ t, baseVersion, op }`.
  - The server checks the op against the role (table below). It applies the op in a single SQLite transaction, increments `version`, then `sendData` sends `{ type: 'TABLE_OP', version, op }` to the room (`topic: 'table'`, reliable). Ops on hidden tokens go only to GM identities.
  - `baseVersion` is only used for logging. Ops are small and commute well enough (a last-writer-wins token move is fine), so stale bases are not rejected.
- Clients apply `TABLE_OP` when `version === local + 1`. On a gap they refetch the snapshot. That one rule covers late joiners, missed packets and reconnects.

| Op | Who |
|---|---|
| `token.move` | GM, or a player who owns the token |
| `token.add` / `token.remove` / `token.update` | GM; a player can add **one** token they own (their character) and update its label/art |
| `scene.set`, `map.set`, `map.grid`, `mode.set` | GM |
| `init.add` | GM; a player can add their own entry |
| `init.set` / `init.next` / `init.prev` / `init.clear` / `init.remove` | GM |
| `handout.share` / `handout.unshare` | GM |

Ephemeral, cosmetic packets stay **client-to-client** over the existing `sendDataPacket()` with `LOSSY` delivery, and are never trusted for state:
- `TABLE_PING { x, y }`: a pulse on the map, 1.5 s.
- `TABLE_DRAG { tokenId, x, y }`: live preview while dragging, throttled to 15 Hz. The commit goes through `token.move` on drop.
- `TABLE_MEASURE { from, to }`: a ruler line while held.

### 2.6 Reconnects

Add a `RoomEvent.Reconnected` handler in `main.js` (none exists for in-call sessions today). It refreshes the ticket via `POST /api/rooms/:room/ticket` (needs the old ticket, which may be up to 24 h past expiry), then refetches the table snapshot. The audience client (`audience.js:37`) gets the same handling.

---

## 3. Dice

The most useful piece, and it works even without a table enabled.

- `server/dice.js`, a small pure module. Grammar: `NdM`, `kh`/`kl` (keep), `dh`/`dl` (drop), `!` (explode, max 100 rerolls), `+`/`-` of dice terms and constants, `adv`/`dis` shorthands, `d%`. Limits: 100 dice per term and 10 terms, so a request can't make the server spin. Uses `crypto.randomInt`.
- `POST /api/rooms/:room/roll` with body `{ t, expr, secret, label }`. It stores a row in `rolls` and sends `{ type: 'TABLE_ROLL', roll }` via `sendData`. A secret roll goes only to the roller plus `gmIdentities`.
- Chat integration (`chat.js` `handleChatSubmit`): text starting with `/r ` or `/roll ` goes to `/roll`, not `/chat`. `/gr` is a secret (GM) roll. `/r` alone repeats the last expression.
- `renderRoll()` in `chat.js`: a roll card showing who rolled, the expression, each die (dropped dice struck through, natural max and min marked), the total in large mono type, and a "Secret" chip. Roll cards **don't expire** after 60 s. They stay for the session, and the last 20 come back through the table snapshot.
- Tests: `node --test server/dice.test.js`. The repo has no test setup yet; `node:test` needs no dependencies.

---

## 4. Table stage (client)

New module `public/js/table/` with ES modules, matching the rest of `public/js`:

| File | Job |
|---|---|
| `table-state.js` | Snapshot and version, `applyOp()`, refetch on gap, a tiny event emitter |
| `table-api.js` | Ticket handling, `op()`, `roll()`, `uploadAsset()` |
| `table-stage.js` | Creates `tile_table`, switches scene and map views, opens and closes |
| `table-map.js` | SVG map: pan, zoom, grid, tokens, drag, pings, measure |
| `table-panel.js` | GM controls and the player panel (tabs: Scene, Map, Tokens, Initiative, Handouts) |
| `table-initiative.js` | Tracker strip and turn highlight |

**Opening the table.**
- A new dock button **Table** between Share and Rec. It is hidden until the room has a table, except for whoever enables it from the Invite dialog ("Make this room a table").
- Opening creates `tile_table` in `#videoGrid`. `getMaximizeTargetId()` (`ui.js:180`) gets a new first branch: `AppState.tableOpen` returns `'tile_table'`, unless the user pinned a person.
- When the GM switches mode or scene, the table opens for everyone (a `TABLE_OP` with `mode.set` or `scene.set`). Players can close it locally.
- A screen share still wins while it is active, so nobody loses a shared screen. The order is pinned tile, then screen share, then table.

**Scene mode (theater of the mind).** A full-bleed image with `object-fit: contain` and an optional caption. A GM changing the scene crossfades it over 300 ms, and respects `prefers-reduced-motion`.

**Map mode.**
- An SVG with a `viewBox` for pan and zoom (wheel, pinch, drag on empty space). The map image goes in `<image>`, the grid is a `<pattern>`, and tokens are `<g>` elements with a circle, art clipped to the circle, and a label.
- Positions are in map pixels, so all clients agree whatever their zoom. Snap to grid on drop, Alt to skip snapping.
- Ping: double-click, or long-press on touch. Measure: hold M and drag, or use the ruler button on touch. Distance in grid units uses the 5-10-5 diagonal rule as an option, with plain Chebyshev distance as the default.
- Owner-only drag. A player's own token gets a magenta ring (magenta is "you" in `design.md`). The token whose turn it is gets a yellow ring.
- Keyboard: tokens are focusable, arrow keys move one cell, Enter selects. Required by `design.md` rule 7.

**Faces on tokens (cheap Tier 2 flourish).** If a token's `owner` matches a participant's clientId, that participant's tile in the sidebar gets the token's colour as a frame accent. Video inside tokens waits for later.

---

## 5. Initiative tracker

- A horizontal strip at the top of the table tile, and a compact version in the dock area on phones. Entries are sorted by value, the current one is highlighted in yellow, and the round counter is shown.
- The GM gets Next / Prev / Clear and can edit any value. Players can add themselves with "Roll initiative", which calls `/roll` with `1d20+mod` and then `init.add` with the result, in one click.
- On `init.next`, the participant whose turn it is gets the yellow "Your turn" chip on their video tile (green stays reserved for the active speaker) and a short system note in chat via the existing `renderSystemNote()`.

---

## 6. Handouts

- The GM uploads assets (kind `handout`) in the Handouts tab. They stay private until shared.
- `handout.share` makes a handout appear for everyone: a card in chat, and a list in the Handouts tab. Images open in a lightbox and PDFs in a new tab via the asset URL.
- Handouts persist for the life of the table. That is the "persistent handouts" item from Tier 1.

---

## 7. Build order (one PR each)

| # | PR | Delivers | Depends on |
|---|---|---|---|
| 1 | **Tickets + dice** | `TICKET_SECRET`, ticket on `/api/token`, `requireTicket`, `rolls` table, `dice.js` with tests, `/roll`, `/r` and `/gr` in chat, roll cards, Reconnected handler | — |
| 2 | **Table foundation** | `tables` and `table_assets`, GM key and link, enable/rotate, snapshot and op endpoints, `sendData` broadcast, version/gap sync, 90-day purge rule | 1 |
| 3 | **Table stage + scenes** | Dock button, `tile_table` as maximize target, scene mode, GM panel (Scene tab), asset upload | 2 |
| 4 | **Map** | Grid settings, tokens (add, drag, own token), pings, measure, hidden tokens filtered | 3 |
| 5 | **Initiative** | Tracker strip, roll initiative, turn chip on tiles | 3 (4 for token links) |
| 6 | **Handouts** | Handouts tab, share/unshare, lightbox | 3 |

PR 1 is useful on its own, for example for theater-of-the-mind games in a plain room, and it settles the identity question that everything else needs.

---

## 8. Later (not in this slice)

- **Fog of war.** The server keeps the revealed regions and sends each viewer only what they may see. Needs map masks cut on the server, or per-viewer rendering. The `hidden` token filtering from 2.4 is the first step.
- **GM-pushed backdrops.** An op `backdrop.set` makes every client call `applyBackground()` with a table asset. Each player can opt out.
- **Character mode.** A portrait in place of the camera, plus a voice effect in the sound pipeline.
- **Actual-play composite.** In Streamer mode, the map plus the cast in one frame for the audience.
- **Character sheets.** Let a player pin a URL or PDF as their sheet. No rules engine.

---

## 9. Open questions

1. **Ticket TTL vs. long sessions.** 12 h, refreshed on reconnect, is assumed. Is anything longer than one evening without a reconnect realistic?
2. **Who may enable a table.** The plan lets anyone in the room. Restricting it to whoever created the room would need a creator key, which doesn't exist today.
3. **Existing unauthenticated endpoints.** `/chat`, `/upload` and `/files/:id` stay unauthenticated in this plan. Tickets would let us close that gap later, as a separate change.
4. **External soundboard.** It joins meet as a participant. If it should react to table events (scene change → ambience), it could subscribe to `topic: 'table'` packets. Check its repo before PR 3 so the packet shape suits it.
