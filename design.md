# meet. design system — Pixel Uplink

This document defines how meet. looks, behaves and reads. It is written against the current `main`, whose identity is the pixel‑art city: diagonal bands of 8‑bit scenes, procedural pixel avatars, and a magenta and cyan neon palette. The system keeps that identity and turns it into rules, then fixes the usability and performance problems the audit below found.

All values live as tokens at the top of `public/styles.css`. If a value you need is not a token, add the token first.

---

## 1. Rules in one screen

1. **Pixel, not glow.** Depth comes from hard offset shadows and whole pixels. Blurred neon glow is not used on UI. It was the main source of glare, paint cost and inconsistent contrast.
2. **One job per hue.** Magenta is you and the primary action. Cyan is system, focus and engaged features. Green is the active speaker only. Yellow is time and attention. Red is leave, recording and destructive actions. Violet is resting structure.
3. **Dark ink on neon.** Text and icons on a neon fill are `--ink` (#0a0b10). White on magenta or red fails contrast. Dark ink passes on every fill.
4. **Sentence case everywhere.** No `text-transform: uppercase`, no all‑caps strings.
5. **Nothing under 14 px.** All type is in rem on a 16 px root. `0.875rem` is the floor. If something does not fit, change the layout.
6. **44 px targets.** Every button, link and input is at least 44 × 44 px, or has an invisible hit area that is.
7. **The art is for arriving, the call is for people.** The pixel city fills the join screen. During a call it is removed from rendering completely.
8. **Zero webfont bytes.** Text uses the system UI and mono stacks. The brand wordmark is a pixel SVG.
9. **Never `alert()`.** Messages use the toast or an inline error.

---

## 2. What is on main today

| Area | What main has |
| --- | --- |
| Join screen | A 280 px panel over five animated diagonal bands of CSS pixel scenes, rotated −12° |
| Call | Violet tile frames, circular avatar frames with procedural pixel faces, a circular 52 px dock |
| New features | Recording, resizable picture‑in‑picture and sidebar gutter, capability‑aware dock, pinned messages, system notes, chat as a side panel on desktop and a bottom sheet on phones |
| Styling | Hex values written inline in about 400 declarations, 80 `!important`, blurred neon `box-shadow` on most elements |

The pixel scenes and avatars are the strongest brand asset in the product and they are kept. The unmerged `glass` branch was not used as a basis.

---

## 3. Usability and performance audit of main

Measured in the desktop app's Chromium pane against a local server, with mock participants for in‑call states. Contrast is WCAG 2.x.

| # | Severity | Finding on main | Evidence | Fix in this system |
| --- | --- | --- | --- | --- |
| 1 | High | Pressing Enter on the join screen does nothing | The fields are not in a `<form>` | Real form; Enter submits |
| 2 | High | Blocking `alert()` dialogs interrupt calls | 14 calls across 4 files | Non‑blocking toast and inline errors |
| 3 | High | Recording and "muted" look identical | Both use the magenta `.active-off` fill | Recording is a red outlined timer; muted is a magenta fill with a slashed icon |
| 4 | High | Text below 14 px throughout the call UI | Dock 11 px, name tags 11 px, TTL 9 px, chat meta 10 px | rem scale with a 0.875rem floor |
| 5 | High | White text on magenta fails contrast | 3.78 : 1 on Copy link, Send, Leave, hand badge | Dark ink on fills, 5.2 : 1 or better |
| 6 | High | Pinch‑zoom is disabled | `maximum-scale=1, user-scalable=no` | Zoom allowed; `touch-action: manipulation` prevents double‑tap zoom |
| 7 | High | Keyboard users lose track of focus | `input { outline: none }`, one focus rule in total | Global `:focus-visible` ring; tiles and menus reachable by keyboard |
| 8 | Medium | Inputs have placeholders but no labels | Placeholder disappears on typing | Visible labels above every field |
| 9 | Medium | Wrong‑password feedback is written into the placeholder | Invisible once the user types | Inline error with `role="alert"`, field marked invalid and focused |
| 10 | Medium | Room names are silently rewritten | "Night Shift!" becomes `nightshift` without notice | Live hint: "Joins #nightshift" |
| 11 | Medium | Dock labels clip on phones | "Unmute" and "React" truncated inside 42 px circles | Pixel icons with labels on desktop, icon‑only 46 px buttons on phones |
| 12 | Medium | Touch targets under 44 px | Copy link 31 px tall, chat buttons 38 px, download 31 px | 44 px minimum everywhere |
| 13 | Medium | Emoji used as UI icons | 📎 ➤ ✕ ⏳ 📌 ⬇ 📁 🖐 render differently per platform | One 16 px pixel icon set |
| 14 | Medium | No landmarks, no accessible state | No `main`, `header`, `nav`, `aside`; zero `aria-` attributes in JS | Landmarks, labelled menus, `aria-label` kept in sync with dock state, `aria-pressed` on pinnable tiles |
| 15 | Medium | Menus cannot be dismissed with Escape or by clicking elsewhere | No key handlers | Escape closes menus, then the chat; outside click closes menus |
| 16 | Low | Tiles are clickable to pin, with no affordance or state | Hidden behaviour | Keyboard‑operable tile, "Pinned" chip when pinned |
| 17 | Low | Busy art directly behind the form | Panel at 92 % opacity over moving scenes | Solid panel plus a radial focus scrim |
| 18 | Perf | LiveKit SDK blocks first paint | 148 KB render‑blocking script, first paint 456 ms | Deferred; first paint 160 ms |
| 19 | Perf | Background animates for the whole call behind opaque UI | Five large composited layers kept animating | `display: none` in session: no layers, no paint |
| 20 | Perf | Blurred shadows everywhere and `transition: all` on tiles | Repaints on every state change | Hard shadows, explicit transition properties, tile containment |
| 21 | Perf | Static files served uncompressed without cache headers | styles.css 23.8 KB, pixel-bg.css 14.5 KB | Brotli/gzip and ETag caching: 10.1 KB and 4.3 KB |

After the changes the same automated audit reports no text under 14 px, no contrast failures, no uppercase text, no controls under 44 px, and no unnamed controls in the gate, header, dock or chat.

---

## 4. Principles

1. **Faces first.** In a call, video is the content. Chrome stays out of the tiles except the name tag and state chips.
2. **State is never colour alone.** Speaking adds a pixel marker to the name tag. Muted adds a slash to the icon and changes the label. Recording shows a running timer.
3. **Say what happened and what to do.** "Camera access is blocked. Allow it in your browser's site settings." Not "Error".
4. **Degrade quietly.** Missing hardware hides controls, old browsers get square corners, reduced motion stops every loop.
5. **Every millisecond counts.** A new effect must be free during a call or it does not ship.

---

## 5. Foundations

### 5.1 Colour

**Surfaces**

| Token | Hex | Use |
| --- | --- | --- |
| `--void` | #06070c | Behind video and screen shares |
| `--bg` | #0a0b10 | App ground |
| `--bar` | #0d0e1b | Header and dock |
| `--surface-1` | #121324 | Panels, tiles, menus, chat |
| `--surface-2` | #1b1c3a | Inputs, bubbles, menu items, dock buttons |
| `--surface-3` | #26284f | Hover on raised surfaces |

**Text**

| Token | Hex | On surface‑1 | Use |
| --- | --- | --- | --- |
| `--text-1` | #f4f2ff | 16.6 : 1 | Primary text |
| `--text-2` | #b9b6d9 | 9.4 : 1 | Labels, secondary text |
| `--text-3` | #8e8bb5 | 5.7 : 1 | Metadata and hints only |
| `--ink` | #0a0b10 | — | Text and icons on neon fills |

**Roles**

| Token | Hue | Meaning | Where |
| --- | --- | --- | --- |
| `--role-brand` | Magenta #ff007f | You, primary action, your device is off | Connect, Send, your bubbles and picture‑in‑picture, muted mic and camera |
| `--role-brand-text` | #ff4d9d | Magenta used as text | Your name in chat, your name tag |
| `--role-info` | Cyan #00f0ff | System, others, focus, engaged feature | Inputs, focus ring, remote names, chat panel, sharing, chat open, fullscreen, pinned tile |
| `--role-live` | Green #39ff14 | Someone is speaking | Speaking tile frame and marker only |
| `--role-time` | Yellow #ffe600 | Time and attention | Message TTL, pinned message, system notes, raised hand |
| `--role-danger` | Red #ff3b5c | Irreversible or privacy‑critical | Leave, recording, destructive menu items, errors |
| `--role-struct` | Violet #7b2cbf | Resting structure | Idle tile frames, file cards |

Violet is decorative at 2.8 : 1. It never carries state or text. Use `--violet-300` (#a77bff, 6.5 : 1) if violet must be read.

**Verified contrast**

| Pair | Ratio |
| --- | --- |
| Ink on magenta | 5.20 |
| Ink on red | 5.65 |
| Ink on cyan | 13.96 |
| Ink on yellow | 15.51 |
| Magenta text #ff4d9d on surface‑2 | 5.34 |
| Red on surface‑1 | 5.27 |
| Cyan on surface‑2 | 11.70 |
| White on magenta (not allowed) | 3.78 |
| White on red (not allowed) | 3.48 |

### 5.2 Typography

| Token | Size | Use |
| --- | --- | --- |
| `--fs-title` | 1.125rem | Panel titles |
| `--fs-body` | 1rem | Inputs, chat messages, menu items, primary button |
| `--fs-small` | 0.875rem | Labels, dock captions, name tags, chips, toasts, metadata |

- `--font-ui` is the system UI stack. `--font-mono` is the system mono stack and is used for things people read out or compare: channel id, TTL, file size, recording timer, room hint.
- The wordmark is an inline pixel SVG, so the brand renders crisply with no font download.
- Weights are 400, 600 and 700 only. No italics. No letter‑spacing on UI text.
- Inputs stay at 1rem so iOS does not zoom on focus.
- Illustration text inside the pixel scenes also follows the 0.875rem floor and sentence case.

### 5.3 The pixel grid

- One pixel unit is 4 px (`--px`). Spacing tokens are multiples of it: 4, 8, 12, 16, 20, 24, 32, 40, 48.
- Strokes are 2 px (`--stroke`). Accent bars on bubbles and notes are one pixel unit, 4 px.
- Icons are drawn on a 16‑unit grid and rendered only at 16, 24 or 32 px so every pixel stays whole.

### 5.4 Shape

- Corners are square. Where the browser supports `corner-shape: notch`, panels, buttons, tiles and chips get a 4 px stepped pixel corner. Unsupported browsers keep square corners, which is also correct.
- No rounded rectangles, no pills and no circles for controls. Main's circular dock buttons and avatar frames are replaced.
- `clip-path` is not used for corners because it would cut off shadows and focus rings.

### 5.5 Elevation

| Token | Value | Use |
| --- | --- | --- |
| `--elev-1` | 2px 2px 0 black | Buttons at rest |
| `--elev-2` | 4px 4px 0 black | Panels, menus, picture‑in‑picture, primary button, toast |
| `--elev-hero` | 6px 6px 0 cyan | The join panel only |

Pressing a button moves it 2 px down and right and removes its shadow, like an arcade key. Shadows are never blurred.

### 5.6 The diagonal

The background bands run at −12°. That angle is the token `--angle`. It appears in the UI exactly once per screen, as the striped strip across the top of the join panel. Do not rotate UI elements.

### 5.7 Iconography

An inline SVG sprite in `index.html` holds 18 pixel icons: mic, cam, react, chat, share, rec, full, leave, close, send, attach, download, pin, clock, hand, alert, slash and link. Use them with `<svg class="icon"><use href="#i-name"/></svg>`.

When JavaScript rewrites text every second, as TTL pills do, the icon is a CSS mask on `::before` so the script can keep writing plain text.

Emoji are content only: reactions and messages. They are never interface icons.

### 5.8 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--t-press` | 80 ms linear | Button press |
| `--t-fast` | 120 ms | Hover and border changes |
| `--t-base` | 200 ms | Toast enter and exit |

- Only `transform` and `opacity` animate. Speaking and state frames switch instantly, which suits the pixel style and costs nothing.
- Loops are limited to the recording indicator, which blinks with `steps(1)`, and the background bands on the join screen.
- `prefers-reduced-motion` stops all loops, including the bands, and turns floating reactions into a short fade.

### 5.9 Illustration

The pixel city lives in `pixel-bg.css` and has its own palette, since it is artwork. Rules:

- It appears full‑bleed on the join screen only.
- In a call, `body.in-session .px-bg { display: none; }` removes it from rendering.
- Text inside scenes follows the 14 px floor and sentence case.
- Scenes must stay transform‑only animation. New scenes reuse the existing band tracks rather than adding layers.

---

## 6. Components

### 6.1 Join gate

- A real `<form>`, 360 px wide, `surface-1`, 2 px magenta border, cyan hero shadow, diagonal strip on top.
- Pixel wordmark, then the promise: "No account. No install. Rooms vanish after 7 days."
- Fields with visible labels: Room name, Your name, Password (optional). Placeholders are examples, never instructions.
- Under the room field a live mono hint shows the channel that will actually be joined.
- Errors appear in one inline region above the button with `role="alert"`. The field at fault gets `aria-invalid="true"`, a red border and focus.
- The button reads Connect, then "Connecting…" and "Opening camera…" while busy, or "Join with password" when a password is needed.
- A radial scrim calms the art behind the form while the edges stay visible.

### 6.2 Header

`bar` surface, cyan bottom rule, 56 px tall. On the left, "Channel" in `text-3` and the channel id in cyan mono. On the right, a red "Recording" chip while you record, and the Copy link button, which becomes icon‑only below 480 px.

### 6.3 Video tile

| State | Treatment |
| --- | --- |
| Rest | `surface-1`, 2 px violet frame |
| Hover (pointer devices) | Frame lightens to violet‑300 |
| Speaking | Green frame plus 2 px inner green line, green pixel marker in the name tag |
| Maximised or screen share | Cyan frame plus inner line |
| Pinned by you | Cyan "Pinned" chip top left |
| Hand raised | Yellow 32 px badge with the pixel hand, top right |
| Keyboard focus | Cyan ring inset 6 px |

State frames are drawn on the tile's `::after` layer, above the video. An inset shadow would be painted underneath the video and disappear.

The whole tile is a button that pins and unpins. It has an accessible name ("Pin Kaito") and `aria-pressed`. Your own tile is not pinnable. Name tags are 14 px, cyan for others and magenta for you.

### 6.4 Avatar

The procedural pixel faces from main stay. The frame changes from a glowing circle to an 80 px square in the avatar's own primary colour with a hard shadow. The blurred glows inside the face are removed.

### 6.5 Picture‑in‑picture and resize handles

Your floating tile has a magenta frame and `elev-2`. The resize handle is a pixel staircase in the top left with a 44 px invisible hit area. The sidebar gutter shows a 4 × 48 px cyan grip and is 16 px wide to grab.

### 6.6 Dock

| State | Look | Label |
| --- | --- | --- |
| Default | `surface-2`, cyan frame, cyan icon and caption | Mic, Cam, React, Chat, Share, Rec, Full |
| Device off | Magenta fill, ink content, slash through the icon | Unmute, Start |
| Feature engaged | Cyan fill, ink content | Stop while sharing, Exit in fullscreen, Chat while the panel is open |
| Recording | Red frame and text, blinking icon, mono timer | 0:42 |
| Leave | Red fill, ink content, set apart with extra space | Leave |
| Unavailable | Hidden by capability checks | — |

- Desktop buttons are at least 68 × 60 px with a 24 px icon above a 14 px caption.
- Phones get icon‑only 46 × 46 px buttons. Seven buttons fit a 375 px screen without scrolling.
- Captions change only through `setDockLabel()`, which keeps the icon and updates `aria-label`.

### 6.7 Menus

`surface-1`, 2 px cyan border, `elev-2`. Items are 44 px tall, 1rem, `text-1`. Hover and focus move to `surface-3` with a cyan border. Destructive items are red with ink text. Escape or a click outside closes them.

### 6.8 Chat panel and sheet

- Desktop: a 340 px side panel. The video grid shrinks to make room, so no video is covered.
- Phones: a bottom sheet at 55 % of the height with a grabber bar.
- Header: "Transmissions" in cyan, with "Chat 1 min · files 10 min" beneath in mono.
- Bubbles have a 4 px left bar: cyan for others, magenta for you, yellow when pinned.
- TTL pills are yellow mono with a clock mask. They turn red in the last 10 seconds for messages and the last 30 for files.
- System notes are yellow with an alert mask and plain sentences, no emoji.
- File cards have a violet frame and a cyan Download button with ink text.
- Attach, message and Send are all 44 px tall. Send is magenta with an ink arrow.

### 6.9 Toast

One at a time, bottom centre above the dock, `role="status"`. It uses a cyan border by default, yellow for warnings and red for errors. Text stays `text-1` in all variants. Messages disappear after 3.6 seconds, or 5 to 6 seconds for warnings and errors.

---

## 7. Content

- Sentence case, short, specific. Name the thing and the fix.
- Buttons are verbs: Connect, Copy link, Download, Unmute, Leave.
- Keep the light "transmission" flavour for the chat panel, and keep the rest plain.

| Instead of | Write |
| --- | --- |
| CONNECT SESSION | Connect |
| Room reached >5 participants. Microphone auto-muted. | More than 5 people joined, so your microphone was muted. Unmute any time. |
| ⚠️ Upload failed — downloading locally instead. | Upload failed, so the recording was downloaded to this device instead. |
| Incorrect Password - Try Again (as placeholder) | That password is not right. Try again. (inline error) |

---

## 8. Accessibility checklist

- [x] Landmarks: `main` gate, `header`, `nav` dock, `aside` chat, `role="log"` on the message stream.
- [x] Visible labels on every input and a visually hidden label on the chat input.
- [x] Global `:focus-visible` ring in cyan with 2 px offset.
- [x] All controls at least 44 px.
- [x] No text below 0.875rem and no uppercase transforms.
- [x] Every text pair at least 4.5 : 1. UI boundaries that carry state at least 3 : 1.
- [x] Zoom allowed.
- [x] Escape closes menus, then the chat.
- [x] Tiles operable with Enter and Space.
- [x] State never shown by colour alone.
- [x] `prefers-reduced-motion` and `forced-colors` handled.
- [ ] Still open: arrow‑key navigation inside menus and returning focus to the dock button after a menu closes.

---

## 9. Performance budget

| Metric | Main | This system |
| --- | --- | --- |
| First contentful paint, local | 456 ms | 160 ms |
| Render‑blocking requests | 3 | 2 |
| styles.css on the wire | 23.8 KB | 10.1 KB |
| pixel-bg.css on the wire | 14.5 KB | 4.3 KB |
| Webfont bytes | 0 | 0 |
| Animated layers during a call | 5 | 0 |
| Blurred shadows on UI | Most elements | None |

Budget for future work: first paint under 200 ms locally, no more than two render‑blocking requests, zero running animations during a call unless a person caused them, and no frame over 16.7 ms while tile states change.

---

## 10. Working with the system

- Add the token first, then use it. Keep literals out of component rules.
- A new state needs a class that CSS styles. JavaScript sets classes and never inline colours.
- A new control needs a pixel icon in the sprite, an accessible name, a 44 px target and a check at 375 px wide.
- After UI changes, paste `tools/ui-audit.js` into the browser console. It reports text under 14 px, contrast failures, uppercase text, targets under 44 px and unnamed controls.
