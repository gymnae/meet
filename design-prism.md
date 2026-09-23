# meet. Prism theme — glass and spectrum

Prism is the second visual style for meet. It takes the direction of the `glass` branch (frosted panels, a pastel rainbow, soft light) and rebuilds it so that the rainbow means something and the glass never costs readability or frame rate.

It runs on the same foundation as the Pixel theme in `design.md`: the same tokens, components, accessibility rules and 14 px floor. Only the visual layer changes. It lives in `public/theme-prism.css` and is switched on with `<html data-theme="prism">`.

- **Switch on the join screen:** "Pixel / Prism". The choice is saved on the device.
- **Force with the URL:** `/?theme=prism`.

---

## 1. The idea

> The room is white light. Each person is one colour of it.

A prism takes white light and separates it into a spectrum. meet. does the same with a room. The interface is colourless glass, like the prism itself. People are the colours. The full rainbow only appears where it really means "everyone":

1. **The join card is the prism.** A beam of white light enters the card from the left and leaves on the right as a spectrum. When the form is complete, the spectrum brightens: you are about to become one of the colours.
2. **The room edge.** In a call, the line under the header is made of one segment per person present, each in their colour. Alone, it is your colour. In a full room, it is the rainbow.

Everywhere else colour belongs to a person, or it is red and means stop.

---

## 2. Critique of the glass branch

The glass branch has the right instinct and the wrong mechanics.

| Glass branch | Problem | Prism |
| --- | --- | --- |
| The same rainbow gradient fills Connect, Copy link and Leave | The rainbow means nothing, and Leave looks like a celebration | Rainbow fill only on Connect. Leave is red. |
| Pastel hues picked by eye (rose, peach, butter, mint, sky, lavender) | Unequal lightness, so each colour has different contrast and a different visual weight | 12 hues at identical OKLCH lightness and chroma |
| `backdrop-filter` on every video tile, name tag, avatar, header and dock over drifting 70 px‑blurred orbs | The GPU re‑blurs every frame of a call. Blur behind an opaque video is invisible anyway. | Real blur only on the join card and on transient menus and toasts. Persistent chrome is solid tinted glass. |
| Background orbs animate during calls | Continuous compositing for a background nobody looks at | Static gradients. Beam and fan are removed in a call. |
| Text on 8 % white glass | Contrast depends on whatever is behind the glass | Glass opacity chosen from a worst‑case backdrop calculation |
| Muted state is rose, from the same family as the rainbow | State and decoration look alike | States use inversion, identity or red, never a pastel |
| Uppercase, 9 to 12 px labels | Same issues as main | Shared rules: sentence case, 14 px floor |

---

## 3. Using the rainbow without losing usability

### 3.1 Equal lightness makes an honest rainbow

A rainbow in HSL is not usable UI colour. Yellow is almost white, blue is almost black, and text contrast swings wildly across it. Prism defines its spectrum in OKLCH, a perceptual colour space, at a fixed lightness of 0.82 and chroma of 0.11, with the hue stepping in 30° increments:

```
oklch(0.82 0.11  15°), oklch(0.82 0.11  45°), … oklch(0.82 0.11 345°)
```

Measured against WCAG:

| Pair | Range across all 12 hues |
| --- | --- |
| Hue as text on the slate background | 9.8 to 10.9 : 1 |
| Dark ink text on the hue | 10.1 to 11.2 : 1 |

Every colour therefore reads the same, weighs the same, and passes AAA both ways. This is what makes the rainbow Connect button and the coloured names legitimate: no stop in the gradient is a weak spot.

### 3.2 Colour is identity, never the only identity

Each person gets a hue from a hash of their display name. The same name produces the same colour on every client, so no server state is needed.

- **Tile:** an identity dot inside the name tag and a gradient avatar with their initial.
- **Speaking:** a 3 px ring in their colour, and the dot becomes a three‑bar sound glyph.
- **Chat:** their name in their colour. Your own messages sit on the right, tinted with your colour.
- **Room edge:** their segment.

Twelve hues cannot give six or more people guaranteed unique colours. Hash collisions happen, and people with colour‑vision deficiency cannot separate neighbouring hues. So colour is always paired with a name, and the speaking state also changes shape. Colour speeds up recognition; it is never required.

We deliberately do not re‑shuffle colours to avoid collisions. Reassigning on join would make someone's colour change mid‑call, which is worse than two people sharing a hue.

### 3.3 States do not use the spectrum

If states used rainbow hues, a green person and a green "live" state would be indistinguishable. Prism states use three treatments that no person can have:

| State | Treatment | Why it can't be confused |
| --- | --- | --- |
| Your device is off (muted mic, camera off) | Inverted: near‑white fill, dark ink, slashed icon | No identity hue is that light |
| A feature is broadcasting you (sharing, chat open) | Tinted with your own colour and ringed in it | It is literally your colour: "this is you, going out" |
| Recording, Leave, destructive | Red at higher chroma than any identity hue | Red is outside the identity chroma band and always paired with an icon or timer |
| Attention (raised hand, pinned tile, pinned message) | The same inverted light chip | Consistent meaning: something needs attention |

### 3.4 Where the full spectrum is allowed

| Place | Why it is justified |
| --- | --- |
| The Connect button | The single entry action. Joining means entering the spectrum. |
| The wordmark | Brand, set large. |
| The join prism beam and fan | Illustration that explains the idea. Static. |
| The room edge in the header | Data: one segment per person. |
| Upload progress | Light filling up. Small and transient. |

Nowhere else. In particular, not on Leave, not on secondary buttons and not on any state.

---

## 4. Glass without guesswork

### 4.1 Minimum opacity from the worst case

Glass contrast depends on what is behind it. Prism computes the worst case: the brightest identity hue at 60 % over the background, directly behind the panel.

| Glass opacity | Primary text | Secondary text | Metadata text |
| --- | --- | --- | --- |
| 0.55 | 8.4 : 1 | 5.4 : 1 | 3.3 : 1, fails |
| 0.70 | 10.7 : 1 | 6.9 : 1 | 4.2 : 1, fails |
| **0.80** | **12+ : 1** | **7.8+ : 1** | **4.75+ : 1, passes** |

`--glass-float` is therefore `rgb(24 26 37 / .8)`. Blur only improves on this by averaging the backdrop.

### 4.2 The glass budget

`backdrop-filter` re‑renders whenever what is behind it changes. Behind a live video that is every frame.

- **Allowed:** the join card, where the background is static. Also menus and toasts, which are small and short‑lived.
- **Not allowed:** tiles, name tags, avatars, header, dock and chat panel. They use solid tinted glass at 88 to 96 % opacity with a 1 px top highlight. It looks the same and costs nothing.
- `prefers-reduced-transparency` removes all blur and uses solid panels.

### 4.3 Measured

| Metric | Value |
| --- | --- |
| First contentful paint, join screen, local | 104 ms |
| Frames over 20 ms while the prism brightens and dims | 0 |
| Animations running during a call | 0 |
| theme-prism.css on the wire | 6.0 KB (Brotli) |
| Webfont bytes | 0 |

---

## 5. Foundations

### Surfaces and text

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | #111219 | App ground, a blue‑slate rather than black so glass reads as glass |
| `--surface-1` | #181a25 | Solid panels |
| `--surface-2` / `--surface-3` | white at 6 % / 11 % | Raised items, hover |
| `--glass-float` | #181a25 at 80 % + blur 22 px | Join card, menus, toast |
| `--text-1` | #f6f4fb | Primary text |
| `--text-2` | #c9c5d8 | Labels |
| `--text-3` | #9d99b3 | Metadata |
| `--ink` | #111218 | Text on light and spectrum fills |
| `--light` | #eeeaf6 | Inverted attention fill (15.8 : 1 with ink) |
| `--role-danger` | #f14445 | Leave and recording fills, with ink text (5.0 : 1) |
| `--danger-text` | #ff7e76 | Red as text on dark (7.4 : 1) |

### Shape

Continuous corners: 10, 14, 20 and 26 px radii, plus pills for chips and single‑line controls. Where supported, `corner-shape: squircle` gives the smooth, Apple‑like curve. Elsewhere, normal radii apply.

### Elevation

Soft, static shadows and a 1 px inner top highlight that makes glass edges catch the light. Nothing animates a shadow.

### Type

The same system stack and scale as Pixel. The wordmark is set in the system UI font at 800 weight and 2.75rem, filled with the spectrum. It is the only gradient text.

### Icons

A second, smooth icon set of 18 icons on a 24‑unit grid with 1.75 px strokes, matching the pixel set name for name. Both sets are in the page. The theme shows one: `.ic-pixel` or `.ic-smooth`. The mute slash cuts a gap into the icon beneath it through the `--slash-gap` custom property.

### Motion

The spectrum fan fades between 32 % and 72 % opacity over 0.7 s when the form becomes ready. Buttons scale to 0.96 to 0.98 on press. There are no loops apart from the recording indicator.

---

## 6. Components

| Component | Prism treatment |
| --- | --- |
| Join card | Glass, 26 px radius, white light enters at a left edge highlight and the spectrum exits at a right edge highlight |
| Connect | Pill, spectrum fill, ink label. The gradient slides on hover. |
| Inputs | 5 % white fill, 38 % white boundary (≥ 3 : 1), white focus ring |
| Header | Solid tinted glass. The room spectrum sits as a 3 px bottom edge. |
| Tile | 20 px radius, 12 % white hairline. The speaking ring sits in the person's colour on a layer above the video. |
| Name tag | Dark pill, identity dot, which becomes sound bars when the person speaks |
| Avatar | 88 px circle, gradient of the person's hue, ink initial |
| Your picture‑in‑picture | Hairline frame, soft shadow, round resize grip |
| Menus, toast | Floating glass with blur. Destructive items are red with ink text. |
| Chat | Your messages right‑aligned and tinted with your colour. Others' messages left‑aligned with their name in their colour. System notes are dashed neutral pills. |
| Dock | A floating glass bar with 20 px radius buttons. States as in 3.3. Leave is red and set apart. |

---

## 7. Choosing between Pixel and Prism

| | Pixel | Prism |
| --- | --- | --- |
| Personality | Loud, playful, arcade | Calm, premium, light |
| Colour carries | Roles (one job per neon) | People (one colour per person) |
| Best for | Social rooms, fun | Work calls, long sessions |
| Join screen cost | Animated pixel bands | Static gradients |
| Call cost | Zero animation | Zero animation |

Both meet the same accessibility checklist. Both are kept honest by `tools/ui-audit.js`, which now lists `oklch()` colours under "checkByHand" instead of mis‑measuring them.
