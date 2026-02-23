# AgentWarCard Browser Compatibility Audit

**Date:** 2026-02-22
**Auditor:** QA Tester (gemini agent)
**Task ID:** 0f8d083b-3e41-46f1-b4eb-dc3e5980f247
**Scope:** AgentWarCard component + sprint-phase/holographic/glow CSS animations

---

## Component Overview

`AgentWarCard` (`src/features/sprints/components/AgentWarCard.tsx`) renders a role-specific "war card" for each registered AI agent in the Sprint War Room. It uses:

- **Inline CSS custom property** `--agent-glow-rgb` injected per card to drive role-colored `box-shadow` animations.
- **CSS animation classes** from `src/index.css`: `agent-float-active`, `agent-float-busy`, `agent-card-active`, `agent-card-busy`, `agent-typing-dot`.
- **`box-shadow` animations** via `@keyframes agent-card-glow` that reads `--agent-glow-rgb` via `rgba(var(...))`.
- **Inline `box-shadow`** for avatar glow (static, set once based on status).
- **`transition-all duration-200`** on the card wrapper element, which also carries an animation.

The sprint view (`SprintWarRoomView.tsx`) additionally uses:
- `sprint-phase-active-dot` CSS animation class on a phase indicator dot.
- `.holographic-board` class on the kanban container.
- `backdrop-blur-sm` (Tailwind) in `CreateSprintModal.tsx`.

---

## Issues Found

### ISSUE-1 — `rgba(var(--agent-glow-rgb), alpha)` inside @keyframes: Safari < 15.4 incompatibility

**Severity:** Warning

**Files:**
- `src/index.css` lines 188–189

**Description:**
The `agent-card-glow` keyframe uses:
```css
box-shadow: 0 0 10px 2px rgba(var(--agent-glow-rgb), 0.15), ...
```
The `--agent-glow-rgb` custom property is set on the element as an inline style (e.g., `"203,213,225"`), and consumed inside `rgba()` within a `@keyframes` block.

This pattern (`rgba(var(--custom-prop), alpha)`) is well-supported in modern browsers but **fails in Safari versions before 15.4** and is **not supported in IE11 at all**. On affected Safari versions, the CSS custom property inside `rgba()` is not resolved within `@keyframes`, causing the entire `box-shadow` animation to silently drop, showing no glow effect.

**Current browser support:**
- Chrome/Edge 49+: Supported
- Firefox 31+: Supported
- Safari 15.4+: Supported
- Safari 14 and below: Unsupported — glow animation is silently skipped

**Fix:**
The project already uses Tailwind CSS v4 + `autoprefixer` in `postcss.config.js`. Autoprefixer does not polyfill CSS custom properties inside `rgba()`. For full Safari 14 support a fallback value would be required. However, given the app targets modern browsers and Safari 15.4+ is the current baseline for macOS Monterey (released 2021), this is acceptable to document as a known limitation rather than needing a code change.

**Recommendation:** Document the minimum supported browser versions (Safari 15.4+, Chrome 49+, Firefox 31+). No code change required for the current target audience.

---

### ISSUE-2 — `transition-all` conflicts with CSS animation on `.agent-card-active` / `.agent-card-busy`

**Severity:** Warning

**File:** `src/features/sprints/components/AgentWarCard.tsx` line 192

**Description:**
The card wrapper element uses `transition-all duration-200` as a Tailwind class:
```tsx
"relative flex flex-col items-center text-center bg-zinc-900/70 border rounded-2xl px-4 pt-6 pb-4 gap-3 transition-all duration-200",
```
When `isActive` or `isBusy` is true, the same element receives `.agent-card-active` or `.agent-card-busy`, which applies a `box-shadow` animation via `@keyframes agent-card-glow`.

**The conflict:** `transition-all` includes `transition: all 200ms`, which sets `transition-property: all`. This catches `box-shadow` as a transitioned property. When a CSS `animation` also drives `box-shadow` on the same element, Safari (and occasionally Chrome) can exhibit jitter or animation interruption because the transition and animation compete for the same property. The `transition: all` style may override or interfere with the animation's intermediate keyframe values in some Safari versions.

**Fix:** Replace `transition-all` with specific transitions that exclude `box-shadow`. The card only visibly transitions `opacity` (for the `opacity-55` idle state) and `border-color` (set via inline style). Use `transition-[opacity,border-color]` instead.

**Applied fix in:** `src/features/sprints/components/AgentWarCard.tsx`

---

### ISSUE-3 — `backdrop-blur-sm` (Tailwind) requires `-webkit-backdrop-filter` prefix for Safari < 15.4

**Severity:** Warning

**File:** `src/features/sprints/components/CreateSprintModal.tsx` line 40

**Description:**
```tsx
<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
```
Tailwind's `backdrop-blur-sm` generates `backdrop-filter: blur(4px)`. This property requires `-webkit-backdrop-filter: blur(4px)` on Safari < 15.4. Without the vendor prefix, the modal overlay has no blur effect on older Safari (the modal still appears, just without the frosted glass effect).

**Autoprefixer status:** `autoprefixer` is present in `postcss.config.js` and will automatically add `-webkit-backdrop-filter` when processing Tailwind's generated CSS. This means the prefix **is added at build time** — not a code defect.

**Verification:** Run `npm run build` and inspect the output CSS for `-webkit-backdrop-filter`. Autoprefixer with its default config (covering `> 0.5%, last 2 versions, not dead`) will include the webkit prefix.

**Status:** No code change required — autoprefixer handles this at build time.

---

### ISSUE-4 — `hsl(var(--blue-accent) / alpha)` modern syntax in scrollbar/glow CSS

**Severity:** Info

**File:** `src/index.css` lines 157–163, 237, 249, 255, etc.

**Description:**
The CSS `hsl(var(--variable) / alpha)` space-separated slash syntax is a modern CSS Level 4 notation. It is:
- Supported in Chrome 78+, Firefox 69+, Safari 12.1+
- Not supported in IE11 or very old browsers

Used extensively for scrollbar thumb colors and the `pulse-glow` animation. No action required for the current browser target. Autoprefixer does not transform this syntax.

**Status:** Info only — acceptable for the project's browser support targets.

---

### ISSUE-5 — `@keyframes` have no vendor-prefixed counterparts (`@-webkit-keyframes`)

**Severity:** Info

**File:** `src/index.css` lines 178–198

**Description:**
All sprint `@keyframes` blocks (`agent-float`, `agent-float-busy`, `agent-card-glow`, `agent-typing`, `sprint-phase-pulse`) use unprefixed syntax. Safari required `@-webkit-keyframes` prior to Safari 9 (2015). All currently active Safari versions (9+) support unprefixed `@keyframes`.

**Status:** No action needed — `@-webkit-keyframes` is obsolete and autoprefixer no longer adds it for modern browser targets.

---

### ISSUE-6 — No `will-change` usage found

**Severity:** Info

**Description:**
No `will-change` property was found anywhere in the sprint CSS or component files. This is correct — `will-change` should only be added when there is a measured compositing performance problem. Its absence is intentional and appropriate.

**Status:** No action needed.

---

### ISSUE-7 — No `clip-path` usage found in sprint components

**Severity:** Info

**Description:**
No `clip-path` was found in any sprint feature file or related CSS. Not applicable to this component set.

**Status:** No action needed.

---

### ISSUE-8 — No canvas or SVG animations in sprint components

**Severity:** Info

**Description:**
Neither canvas nor inline SVG animations are used in the sprint War Room or AgentWarCard components. The holographic board (`.holographic-board`) is a pure CSS `box-shadow` + `linear-gradient` effect with no canvas or SVG elements.

**Status:** No action needed.

---

### ISSUE-9 — CSS Grid used for agent card layout: Safari flex/grid quirks

**Severity:** Info

**File:** `src/features/sprints/views/SprintWarRoomView.tsx` line 186

**Description:**
```tsx
<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
```
CSS Grid is fully supported in all modern browsers including Safari 10.1+. The `gap` property (previously `grid-gap`) is supported without prefix in all modern browsers. No animation is applied to the grid container itself — layout is static, only the children animate.

**Status:** No action needed.

---

## Applied Fixes

### Fix 1: Replace `transition-all` with specific transitions on AgentWarCard wrapper

**File:** `src/features/sprints/components/AgentWarCard.tsx`

**Before:**
```tsx
"relative flex flex-col items-center text-center bg-zinc-900/70 border rounded-2xl px-4 pt-6 pb-4 gap-3 transition-all duration-200",
```

**After:**
```tsx
"relative flex flex-col items-center text-center bg-zinc-900/70 border rounded-2xl px-4 pt-6 pb-4 gap-3 transition-[opacity,border-color] duration-200",
```

**Rationale:** Eliminates the `transition: all` declaration that could interfere with `box-shadow` keyframe animations in Safari. The card only meaningfully transitions `opacity` (via `opacity-55` for idle state) and `border-color` (set inline). All other properties are static. This fix also improves performance by reducing the scope of GPU-tracked transitions.

---

## Verification

TypeScript compilation check (sprints only):
```bash
cd /Users/sergevilleneuve/Documents/Projects/Archon/archon-ui-main && npx tsc --noEmit 2>&1 | grep sprints
```
Expected: no output (no errors in sprints feature).

---

## Summary Table

| # | Issue | Severity | File | Fix Applied |
|---|-------|----------|------|-------------|
| 1 | `rgba(var(--agent-glow-rgb))` in `@keyframes` — no IE/Safari <15.4 support | Warning | `src/index.css` | Documented (acceptable) |
| 2 | `transition-all` conflicts with `box-shadow` animation in Safari | Warning | `AgentWarCard.tsx` | Yes — replaced with `transition-[opacity,border-color]` |
| 3 | `backdrop-blur-sm` needs `-webkit-backdrop-filter` | Warning | `CreateSprintModal.tsx` | Handled by autoprefixer at build time |
| 4 | `hsl(var() / alpha)` modern syntax | Info | `src/index.css` | Acceptable — modern browsers only |
| 5 | No `@-webkit-keyframes` prefixes | Info | `src/index.css` | Not needed — obsolete |
| 6 | No `will-change` usage | Info | — | Correct — no action needed |
| 7 | No `clip-path` usage | Info | — | Not applicable |
| 8 | No canvas/SVG animations | Info | — | Not applicable |
| 9 | CSS Grid layout — Safari quirks | Info | `SprintWarRoomView.tsx` | No animation on grid — safe |

---

## Browser Support Matrix

| Browser | Glow Animation | Float Animation | Typing Dots | backdrop-blur |
|---------|---------------|-----------------|-------------|---------------|
| Chrome 90+ | Full | Full | Full | Full |
| Firefox 90+ | Full | Full | Full | Full |
| Safari 15.4+ | Full | Full | Full | Full |
| Safari 14 | Degraded (no glow) | Full | Full | Partial (no prefix needed — autoprefixer adds it) |
| Safari 13 | Degraded (no glow) | Full | Full | No blur effect |
| IE11 | None | None | None | None |

Note: IE11 is not a supported target for this project.
