---
title: Brand
description: Archon brand foundation — colors, logo, and usage guidelines.
---

## Quick reference

The essentials at a glance:

- **Primary gradient** — <code style="color:#ED10EC">#ED10EC</code> → <code style="color:#8E40C8">#8E40C8</code> → <code style="color:#06CE94">#06CE94</code>
- **Surface** — <code style="color:#0F1115;background:#fff;padding:0 6px;border-radius:3px">#0F1115</code>
- **Logo** — the shield mark with the abstract Archon glyph, stroked with the primary gradient

Use the embedded foundation below for the canonical version. If you need a vector asset or have a question about an unusual usage, open a discussion on [GitHub](https://github.com/coleam00/Archon/discussions).

## Console design tokens

The console dimension scale lives in [`packages/web/src/index.css`](https://github.com/coleam00/Archon/blob/dev/packages/web/src/index.css). The table below is generated from its `@theme inline` declarations. Regenerate it with `bun run scripts/check-console-tokens.ts --write-docs`; normal lint checks for drift.

<!-- console-tokens:start -->

| Utility | CSS value |
| --- | --- |
| `text-console-9` | `9px` |
| `text-console-10` | `10px` |
| `text-console-11` | `11px` |
| `text-console-12` | `12px` |
| `text-console-13` | `13px` |
| `text-console-14` | `14px` |
| `text-console-15` | `15px` |
| `text-console-17` | `17px` |
| `text-console-18` | `18px` |
| `text-console-22` | `22px` |
| `text-console-34` | `34px` |
| `rounded-console-12` | `12px` |
| `rounded-console-16` | `16px` |
| `tracking-console-label` | `0.14em` |
| `tracking-console-label-wide` | `0.16em` |
| `tracking-console-display` | `0.2em` |
| `tracking-console-tight` | `-0.2px` |
| `tracking-console-tighter` | `-0.4px` |
| `tracking-console-detail` | `0.3px` |
| `tracking-console-badge` | `0.6px` |
| `tracking-console-body` | `-0.005em` |
| `tracking-console-heading` | `-0.028em` |
| `rounded-sm` | `calc(var(--radius) - 4px)` |
| `rounded-md` | `calc(var(--radius) - 2px)` |
| `rounded-lg` | `var(--radius)` |
| `rounded-xl` | `calc(var(--radius) + 4px)` |
| `rounded-2xl` | `calc(var(--radius) + 8px)` |
| `rounded-3xl` | `calc(var(--radius) + 12px)` |
| `rounded-4xl` | `calc(var(--radius) + 16px)` |

<!-- console-tokens:end -->

Console font tokens set only font size, preserving inherited or explicit line height. Shared radii retain their formulas relative to `--radius` (the shared base radius). `rounded` uses Tailwind's default radius. Tracking utilities cover labels, details and the console's scoped body and heading defaults.

Spacing and sizing use Tailwind's default spacing scale, including decimal multipliers: `gap-4.5`, `py-2.75` and `w-37.5`. These correspond to 18px, 11px and 150px at the default 16px root size; they scale with the browser's root font setting.

Lint rejects arbitrary numeric `px`, `rem` and `em` lengths in console font, radius, tracking, spacing, sizing, offset, grid-template and translation utilities. Colors, shadows, blur, rings, line height, percentages and viewport-only values remain outside this rule. A one-off composite layout may use an exact adjacent exception:

```tsx
// console-token-exception w-[calc(50%-4px)] -- Segment indicator subtracts its local inset from half the control.
const indicatorWidth = 'w-[calc(50%-4px)]';
```

The comment must be on the immediately preceding physical line, name the entire utility including variants, and give a nonempty reason. Single-line block comments work too. Use a local constant when JSX formatting would separate the comment from the literal. Malformed and unused exceptions fail lint. See the [console README](https://github.com/coleam00/Archon/blob/dev/packages/web/src/experiments/console/README.md) for ownership and routes.

## Full brand sheet

The Archon brand foundation lives below. It's a single self-contained page covering the logo, color system, typography, and approved usage.

<iframe
  src="/brand/foundation.html"
  title="Archon Brand Foundation"
  style="width:100%;height:80vh;border:1px solid var(--sl-color-gray-5);border-radius:8px;background:#0F1115;"
  loading="lazy"
></iframe>

Prefer a full-window view? [Open the brand sheet in a new tab](/brand/foundation.html).
