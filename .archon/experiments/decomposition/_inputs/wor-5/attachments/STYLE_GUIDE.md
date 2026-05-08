# Conflict Coach — Style Guide

**Version:** 1.0 · April 2026
**Audience:** The implementing agent (and any designer or engineer after it). This document is the single source of truth for visual decisions. When it disagrees with code, update this file first, then the code.

---

## 0. How to use this guide

The agent reads this file before touching any UI. The order of authority is:

1. **`docs/style/STYLE_GUIDE.md`** — this file. Decisions, rationale, hard rules.
2. **`docs/style/globals.css`** — runtime source of truth for tokens.
3. **`docs/style/theme.ts`** — programmatic mirror. Use only when JS needs raw values (charts, SVG, email).
4. **`docs/style/components.css`** — reusable class recipes (`.cc-btn-primary`, `.cc-bubble-coach`, …) for patterns that appear in more than one component.
5. **`docs/style/shadcn-overrides.tsx`** — drop-in replacements for shadcn primitives pre-wired to these tokens.
6. **`docs/style/style-guide.html`** — visual reference. Open it to see what "correct" looks like.

If something isn't covered here, ask. Do not invent a new color, radius, or motion curve.

---

## 1. Principles (in priority order)

Five rules. When two conflict, the earlier one wins.

1. **Calm over clever.** The user is in a stressful conversation. The UI must feel like a breath, not a game. No saturated colors, no celebratory motion, no emoji from the product voice.
2. **The human decides.** Every AI output is a suggestion. The Send button is always a human action, never automatic.
3. **Privacy is visible.** When data is private, the screen says so — with a lock icon, a warm tint, and plain-English copy. Trust is earned by showing the seams.
4. **One primary action.** Exactly one sage-filled button per screen. Everything else is secondary or ghost. If you feel the need for two primaries, one of them is wrong.
5. **Presence over polish.** Spend motion on real interaction — streaming cursors, live status, arriving messages. Not on decorative flourish.

---

## 2. Color

### 2.1 Palette philosophy

Warm off-whites and sage greens. No pure black, no pure white in the light theme. Every neutral has a slight amber warmth; every accent is slightly desaturated. Dark mode inverts luminance but preserves warmth.

### 2.2 Token reference

All tokens are declared in `globals.css` as CSS custom properties. Reference them via utility classes (`bg-canvas`, `text-primary`) or CSS vars (`var(--accent)`). Never paste a hex into a component.

#### Neutrals

| Token                    | Light     | Dark      | Use                                                         |
| ------------------------ | --------- | --------- | ----------------------------------------------------------- |
| `--bg-canvas`            | `#FAF8F5` | `#1A1816` | Page background — the "outside" of everything.              |
| `--bg-surface`           | `#FFFFFF` | `#242220` | Cards, bubbles, inputs — the "inside" of things.            |
| `--bg-surface-subtle`    | `#F3EFE9` | `#2E2B28` | Hover states, alt rows, quiet containers.                   |
| `--text-primary`         | `#1F1D1A` | `#F2EFE9` | Default body and heading color.                             |
| `--text-secondary`       | `#5C5952` | `#A8A39A` | Meta, helper text, secondary labels.                        |
| `--text-tertiary`        | `#8A8680` | `#7A766E` | Timestamps, placeholders, very quiet labels.                |
| `--border-default`       | `#E5E0D8` | `#3A3632` | Default 1px borders. Dividers.                              |
| `--border-strong`        | `#CBC4B8` | `#4A4640` | Input borders, stronger dividers.                           |

#### Accent — Sage (primary action)

| Token              | Light     | Dark      | Use                                            |
| ------------------ | --------- | --------- | ---------------------------------------------- |
| `--accent`         | `#6B8E7F` | `#89A99B` | Primary button fill, selected state, focus ring. |
| `--accent-hover`   | `#5A7A6C` | `#9ABAAC` | Primary button hover.                          |
| `--accent-subtle`  | `#DCE7E0` | `#2E3A35` | Coach bubble background, selected card tint.  |
| `--accent-on`      | `#FFFFFF` | `#1A1816` | Text on accent fill (primary button label).    |

#### Coach — Dusty Lavender (AI identity)

Used exclusively for AI Coach touches in the **joint session**, where the coach needs to be visually distinct from either party. In the **private phase**, the Coach uses `--accent-subtle` bubbles because there's no party color to conflict with.

| Token              | Light     | Dark      | Use                                     |
| ------------------ | --------- | --------- | --------------------------------------- |
| `--coach-accent`   | `#8B7AB5` | `#A797CC` | Left border on joint-session bubbles, sparkles icon. |
| `--coach-subtle`   | `#EAE4F2` | `#342E42` | Joint-session Coach bubble background.  |

#### Party colors (joint chat)

| Token                          | Light     | Dark      | Use                                |
| ------------------------------ | --------- | --------- | ---------------------------------- |
| `--party-initiator`            | `#6B85A8` | `#8BA3C2` | Avatar bg for case initiator.      |
| `--party-initiator-subtle`     | `#DFE5EF` | `#2C3542` | Initiator bubble background.       |
| `--party-invitee`              | `#B07A8F` | `#CC96A9` | Avatar bg for invitee.             |
| `--party-invitee-subtle`       | `#EFE0E4` | `#3E2E34` | Invitee bubble background.         |

Assignments are stable per case — whoever created the case is always the initiator color on both screens.

#### Feedback

| Token              | Light     | Dark      | Use                                            |
| ------------------ | --------- | --------- | ---------------------------------------------- |
| `--danger`         | `#B5594D` | `#CC786D` | Destructive button, error border, error text.  |
| `--danger-subtle`  | `#F2DCD8` | `#3E2A27` | Error bubble / banner background.              |
| `--warning`        | `#B58B4D` | `#CC9F6D` | Draft-coach caution, "Ready" status highlight. |
| `--warning-subtle` | `#F2E5D4` | `#3E3228` | Warning banner background.                     |
| `--success`        | `#6B8E7F` | `#89A99B` | Aliased to `--accent`. Resolved-case accents.  |

No pure red. Terracotta is the danger hue — it reads as serious without feeling aggressive.

#### Tints

| Token            | Light     | Dark      | Use                                                                 |
| ---------------- | --------- | --------- | ------------------------------------------------------------------- |
| `--private-tint` | `#F0E9E0` | `#2D2924` | Any private-to-user surface. Synthesis card, Draft Coach, "private" banners. This color does the heavy lifting of **"you can only see this."** |

### 2.3 Contrast

Every foreground/background pair hits WCAG AA (4.5:1 for body, 3:1 for large). Dark mode was checked separately. If you introduce a new combo, re-verify.

---

## 3. Typography

### 3.1 Families

- **Inter** — everything UI.
- **JetBrains Mono** — invite codes, case IDs, any token or machine string.

Load both from Google Fonts at weights 400, 500, 600 (Inter) and 400, 500 (Mono). No variable-font axes beyond weight.

### 3.2 Weights

- **400 Regular** — body, chat, meta, timestamps.
- **500 Medium** — every heading, every label, every button. **Never use 700.** Bold headings feel shouty in a mediation context.
- **600 Semibold** — reserved. Not currently used.

### 3.3 Scale

| Role      | Size | Line | Weight | Tracking  | Use                                                |
| --------- | ---- | ---- | ------ | --------- | -------------------------------------------------- |
| display   | 32   | 40   | 500    | -0.02em   | Onboarding hero, landing page headline.            |
| h1        | 24   | 32   | 500    | -0.015em  | Page titles, case names.                           |
| h2        | 20   | 28   | 500    | -0.01em   | Section headers inside a page.                     |
| h3        | 17   | 24   | 500    | 0         | Synthesis card section, sub-headers.               |
| body      | 15   | 1.6  | 400    | 0         | Default paragraph text.                            |
| chat      | 16   | 1.55 | 400    | 0         | Message bubble text — bumped up for readability.   |
| label     | 14   | 20   | 500    | 0         | Form labels, button text.                          |
| meta      | 13   | 18   | 400    | 0         | Helper text, meta rows, secondary info.            |
| timestamp | 12   | 16   | 400    | 0         | Timestamps, ultra-quiet labels.                    |

`body` and `chat` use unitless line-heights so they scale with user font-size preferences. Everything else uses px lines for deliberate vertical rhythm.

### 3.4 Rendering

Always:

```css
-webkit-font-smoothing: antialiased;
-moz-osx-font-smoothing: grayscale;
text-rendering: optimizeLegibility;
```

Set once on `html` in `globals.css`. Already handled.

---

## 4. Spacing, radius, shadow

### 4.1 Spacing (8-point grid)

Scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`. These map to Tailwind's default `1, 2, 3, 4, 5, 6, 8, 10, 12, 16` — no custom spacing extension needed.

### 4.2 Radius

| Token           | Value | Use                                         |
| --------------- | ----- | ------------------------------------------- |
| `--radius-sm`   | 6px   | Small pills, input corners on dense forms.  |
| `--radius-md`   | 10px  | Buttons, inputs, compact cards.             |
| `--radius-lg`   | 14px  | Bubbles, case rows, panels.                 |
| `--radius-xl`   | 20px  | Modals, large feature cards.                |
| `--radius-full` | 9999  | Pills, avatars, circular buttons.           |

No hard corners. Never use `border-radius: 0` on interactive surfaces.

### 4.3 Shadow

| Token          | Value                           | Use                                    |
| -------------- | ------------------------------- | -------------------------------------- |
| `--shadow-0`   | `none`                          | Default. Most surfaces are flat.       |
| `--shadow-1`   | `0 1px 2px rgba(0,0,0,.04)`     | Cards that need a whisper of lift.     |
| `--shadow-2`   | `0 4px 12px rgba(0,0,0,.06)`    | Popovers, dropdowns, tooltips.         |
| `--shadow-3`   | `0 12px 32px rgba(0,0,0,.10)`   | Modals, side sheets (Draft Coach).     |

Dark mode scales alpha up (`.20 / .28 / .40`) so the elevation is still visible.

---

## 5. Motion

- **Ease:** `cubic-bezier(0.2, 0.7, 0.3, 1)` for everything. Slightly bouncy exit, confident arrival.
- **Duration:** 150ms for hover/state change. 200ms for panels/sheets. 300ms only for first-time reveals.
- **No bounce, no spring, no decorative.** Motion serves the interaction, not the brand.
- **Streaming cursor** is the one exception — a 1s steps(2) blink on AI text as it arrives. This is a feature, not decoration.
- **Respect `prefers-reduced-motion`.** Already wired in `globals.css`.

---

## 6. Components

### 6.1 Buttons

One variant per intent. Size variants exist but should be used sparingly.

| Variant     | When                                              |
| ----------- | ------------------------------------------------- |
| `primary`   | The one action you want the user to take. Sage fill. |
| `secondary` | Alternative actions (Cancel, Back, Edit).         |
| `ghost`     | Tertiary — icon buttons, header nav.              |
| `danger`    | Close case, delete draft, destructive only.       |
| `link`      | In-flow text links.                               |

- Heights: sm 32, md 40, lg 48.
- Icon-only: 36×36, always labelled via `aria-label`.
- Disabled: 50% opacity, `cursor: not-allowed`, pointer-events: none. Never a different fill color.

### 6.2 Inputs & textareas

- Border `--border-strong` default. On focus, border goes `--accent` with a 3px `--accent-subtle` ring.
- Placeholder is `--text-tertiary`. Never use placeholder as a label.
- Error state: `aria-invalid="true"` → border and ring switch to danger.
- Textareas default to `min-height: 96px`, `resize: vertical`.

### 6.3 Radio cards (category picker)

Used for the "What kind of conflict?" step and any small multi-choice question where each option has a description.

- Default: 1px border `--border-default`.
- Selected: **2px** border `--accent`, background `--accent-subtle`, icon color shifts to accent. Padding compensates for the extra pixel so width stays stable.

### 6.4 Chat bubbles

This is the most-reused component. Six flavors, each with a semantic meaning.

| Bubble class                 | Background          | Border                           | When                                            |
| ---------------------------- | ------------------- | -------------------------------- | ----------------------------------------------- |
| `.cc-bubble`                 | `--bg-surface`      | `1px var(--border-default)`      | User's own messages (private + joint).          |
| `.cc-bubble-coach`           | `--accent-subtle`   | none                             | Coach messages in **private** phase.            |
| `.cc-bubble-coach-joint`     | `--coach-subtle`    | `3px left var(--coach-accent)`   | Coach in **joint** chat (standard).             |
| `.cc-bubble-coach-intervention` | `--coach-subtle` | `4px left var(--coach-accent)`   | Coach mid-argument intervention (heavier left).  |
| `.cc-bubble-party-initiator` | `--party-initiator-subtle` | none                   | Initiator's own messages in joint chat.         |
| `.cc-bubble-party-invitee`   | `--party-invitee-subtle`   | none                   | Invitee's messages in joint chat.               |
| `.cc-bubble-error`           | `--danger-subtle`   | `1px var(--danger)`              | Error state (Coach unavailable, retry prompt).  |

Every bubble:
- `padding: 12px 16px`
- `border-radius: var(--radius-lg)` (14px)
- `max-width: min(640px, 80%)`
- Font: chat (16/1.55)
- Enter animation: 150ms fade + 8px y translate. Once. Do not repeat on scroll.

**Streaming cursor:** a 2px × 1em `currentColor` bar, `animation: cc-blink 1s steps(2, start) infinite`. Placed inline at end of text as it streams. Remove when streaming completes.

### 6.5 Avatars

- Default: 32×32, `border-radius: full`, white initials on a party color.
- Sizes: sm 24, md 32, lg 40. No larger — Conflict Coach has no profile page.
- Colors: `avatar-initiator`, `avatar-invitee`, `avatar-coach`, `avatar-you`. The "you" avatar uses the sage accent — it's the one place the user sees themselves as the primary action color.
- Coach avatar can use a glyph (`⟡`) instead of a letter in joint sessions where the C would read as confusing.

### 6.6 Privacy banner

Every private surface has a banner at the top. Exactly one per phase.

```html
<div class="cc-banner-privacy">
  <svg><!-- lucide lock --></svg>
  <div>
    <strong>Private to you.</strong> Jordan will never see any of it.
    <a href="/privacy">Learn more</a>
  </div>
</div>
```

- Background: `--private-tint` (warm beige/dark amber). Same color everywhere privacy matters — this is the **visual shorthand for "you can only see this."**
- Lock icon is `lucide-react` `Lock` at 16×16, `--text-secondary`.
- Warning variant: switch the icon to `ShieldAlert` and the bg to `--warning-subtle`. Used for draft-warning states only.

### 6.7 Status pills

| Pill           | Color               | When                                           |
| -------------- | ------------------- | ---------------------------------------------- |
| `pill-turn`    | accent on accent-subtle | User's turn to act.                        |
| `pill-waiting` | secondary, outlined dot | Waiting on the other party.                |
| `pill-ready`   | warning              | Joint session ready to enter (soft nudge).    |
| `pill-closed`  | tertiary, square dot | Resolved / archived.                           |

Pill dot shape encodes state: filled circle = active, hollow circle = waiting, square = closed.

### 6.8 Synthesis card

The pre-joint-session moment. It exists to make the user pause before opening the joint chat.

- Background: `--private-tint`. Padded 32px. Radius 14. One per party, never shared.
- Three fixed H3 sections in order: **Areas of likely agreement**, **Points that will need real discussion**, **Suggested approach**. Generated in Coach's own words, never quoting the other party.
- Always paired with the private banner above it (borders joined, no gap).
- CTA at the bottom: single primary button, "Enter joint session →".

### 6.9 Draft Coach panel

Right-side sheet, 420px wide on desktop, bottom sheet on mobile.

- Header: sparkles icon (`--coach-accent`), "Draft Coach" title, lock icon (visual confirmation it's private), close button.
- Private banner directly under header.
- Body: private coaching conversation — uses the same chat bubbles at 14px instead of 16px (narrower surface).
- When Coach produces a final draft, it appears in a `.cc-draft-ready` card — subtle background, quoted text. Followed by a vertical stack of actions: **Send this message** (primary), **Edit before sending** (secondary), **Keep refining with Coach** (ghost), **Discard** (ghost, danger text).
- The user is always the one who sends. Never auto-post.

### 6.10 Solo-mode party toggle

Distinctive by design. Tester should never confuse solo mode with a real conversation.

- Lavender (Coach-colored) border and subtle background — says "this is an AI-adjacent meta control."
- Left label: "VIEWING AS" in uppercase 11px.
- Two segmented buttons: initiator name and invitee name. Active button gets a subtle surface lift and primary text color.
- Position: top-right of the phase header in solo cases.

### 6.11 Case row (dashboard)

- Grid: avatar 40, content 1fr, action auto.
- Padding 20/24. Radius 14. Hover: background `--bg-surface-subtle`.
- Content stack: `Title (16/500)` → `Category · date (meta)` → `Status pill` → `Last activity (timestamp)`.
- Closed cases: `opacity: 0.75` and grayscale avatar.

### 6.12 Modal / Dialog

- Max width 480. Padding 24. Radius 20 (intentionally softer than cards — modals feel like pillows, not cards).
- Shadow 3. Overlay: `rgba(0,0,0,.3)` + 2px backdrop blur.
- Title 20/500, description `--text-secondary` 15/1.6. Actions bottom-right, primary rightmost.
- Animation: 150ms fade + 95%→100% scale on enter. Reverse on exit.

### 6.13 Phase header

Top strip on every in-case screen. Left: back arrow + "Dashboard" link. Center: `Case name · Phase name`. Right: phase-specific actions.

- Height 56 (12px vertical padding + 32px content).
- Background `--bg-surface`, 1px bottom border.
- "Dashboard" link is `--text-secondary`, hover to primary. Separator is `·` in tertiary.

---

## 7. Icons

Library: `lucide-react`.

Install:

```bash
npm i lucide-react
```

| Role                     | Icon                | Size | Color                |
| ------------------------ | ------------------- | ---- | -------------------- |
| Private / locked         | `Lock`              | 16   | `--text-secondary`   |
| AI / Coach               | `Sparkles`          | 16   | `--coach-accent`     |
| Draft warning            | `ShieldAlert`       | 16   | `--warning`          |
| Coach-verified           | `ShieldCheck`       | 16   | `--accent`           |
| Send message             | `Send`              | 16   | inherits from button |
| Close / dismiss          | `X`                 | 16   | inherits             |
| Back nav                 | `ArrowLeft`         | 14   | `--text-secondary`   |
| Forward / enter          | `ArrowRight`        | 14/16| inherits             |
| Category: workplace      | `Briefcase`         | 20   | inherits from card   |
| Category: family         | `Home`              | 20   | inherits             |
| Category: personal       | `Users`             | 20   | inherits             |
| Category: contractual    | `FileText`          | 20   | inherits             |
| Shared visibility        | `Users`             | 16   | `--text-secondary`   |
| Edit draft               | `Pencil`            | 16   | inherits             |
| Regenerate / refine      | `RefreshCw`         | 16   | inherits             |
| Copy                     | `Copy`              | 16   | inherits             |
| Error / alert            | `AlertTriangle`     | 16   | `--danger`           |
| Guidance reference       | `BookOpen`          | 14   | inherits             |
| Discard draft            | `Trash2`            | 16   | `--danger`           |

Always give icons `width` and `height` props (stroke scales with size). Default stroke width 2.

---

## 8. Copy voice

### Never use

- "arbiter", "verdict", "judgment" — legal framing
- "the parties" — impersonal. Use the actual names.
- 🎉 or exclamation marks from the product voice
- "Get started free", pricing language
- "Congratulations on resolving your conflict!"

### Use instead

- "coach", "guidance", "synthesis", "resolution"
- "You and Jordan" (or real names)
- Steady, curious tone. The AI offers, suggests, wonders. It does not assert.
- Plain descriptions. "Case closed." over "Amazing — you did it!"

### Coach voice

Calm, curious, specific. The Coach is a seasoned mediator, not a cheerleader. If a line could appear in a birthday card, rewrite it.

---

## 9. Accessibility checklist

- [ ] All interactive surfaces reachable by keyboard.
- [ ] Focus ring visible (`:focus-visible` is wired in `globals.css`).
- [ ] Every icon either labelled or decorative (`aria-hidden` + label elsewhere).
- [ ] Color never the sole carrier of meaning (status pills pair color + shape + text).
- [ ] `prefers-reduced-motion` respected. Streaming cursor stops animating under reduced motion.
- [ ] WCAG AA contrast in both themes.

---

## 10. File map

```
docs/style/
├─ STYLE_GUIDE.md          ← this doc — decisions & rationale
├─ globals.css             ← runtime tokens, @theme, base layer
├─ components.css          ← reusable class recipes
├─ theme.ts                ← TypeScript mirror, for JS-driven visuals
├─ tailwind.config.ts      ← v4 shim for tooling
├─ shadcn-overrides.tsx    ← drop-in shadcn primitives
└─ style-guide.html        ← visual reference — open to see "correct"
```

### How to wire this into the app

1. Copy `globals.css` and `components.css` into `src/styles/`.
2. Import from your entry: `import "./styles/globals.css";` (components.css is pulled in by globals).
3. Copy `theme.ts` into `src/styles/theme.ts` for typed token access.
4. Copy the bits you want from `shadcn-overrides.tsx` into `src/components/ui/` and delete the stock shadcn versions.
5. Set initial theme on the root: `<html data-theme="light">`. Toggle with a small inline script that reads `localStorage` + `prefers-color-scheme` before paint.

### When you add a new component

1. Check if the pattern exists in `components.css`. If yes, use it.
2. If it's truly new, propose it here first (add a section to §6). Then add the class recipe.
3. Never introduce a one-off color, radius, or shadow. If you need a value that isn't in §2/§4, the token system is missing something — raise it.

---

*End of style guide. Questions? The answer is probably "match `style-guide.html`."*
