---
paths:
  - "packages/web/**/*.tsx"
  - "packages/web/**/*.ts"
  - "packages/web/**/*.css"
---

# Web Frontend Conventions

## Tech Stack

- React 19 + Vite 6 + TypeScript
- Tailwind CSS v4 (CSS-first config)
- shadcn/ui components
- TanStack Query v5 for REST data
- React Router v7 (`react-router`, NOT `react-router-dom`)
- Manual `EventSource` for SSE streaming (no library)
- **Dark theme only** — no light mode toggle

## Tailwind v4 Critical Differences

```css
/* CORRECT: CSS-first import */
@import 'tailwindcss';
@import 'tw-animate-css';  /* NOT tailwindcss-animate */

/* CORRECT: theme variables in @theme inline block */
@theme inline {
  --color-surface: var(--surface);
  --color-accent-bright: var(--accent-bright);
}

/* WRONG: never use @tailwind base/components/utilities */
```

Plugin in `vite.config.ts`: `import tailwindcss from '@tailwindcss/vite'` — uses Vite plugin, **not PostCSS**. `components.json` has blank `tailwind.config` for v4.

## Color Palette (oklch)

All custom colors are OKLCH. Key tokens (defined in `:root` in `index.css`):
- `--surface` (0.18): main surface
- `--surface-elevated` (0.22): cards, popovers
- `--background` (0.14): page background
- `--primary` / `--ring`: blue accent at oklch(0.65 0.18 250)
- `--text-primary` (0.93), `--text-secondary` (0.65), `--text-tertiary` (0.45)
- `--success` (green 155), `--warning` (yellow 75), `--error` (red 25)

Use CSS variables via Tailwind utilities: `bg-surface`, `text-text-primary`, `border-border`, `text-accent-bright`, etc.

## SSE Streaming Pattern

`useSSE()` in `src/hooks/useSSE.ts` is the single SSE consumer. It:
- Opens `EventSource` to `/api/stream/{conversationId}`
- Batches text events (50ms flush timer) to reduce re-renders
- Flushes immediately before `tool_call`, `tool_result`, `workflow_dispatch` events
- Marks disconnected only on `CLOSED` state (not `CONNECTING` — avoids flicker)
- `handlersRef` pattern ensures stable EventSource with fresh handlers

Event types: `text`, `tool_call`, `tool_result`, `error`, `conversation_lock`, `session_info`, `workflow_step`, `workflow_status`, `parallel_agent`, `workflow_artifact`, `dag_node`, `workflow_dispatch`, `workflow_output_preview`, `warning`, `retract`, `heartbeat`.

## Routing

```tsx
// CORRECT
import { BrowserRouter, Routes, Route } from 'react-router';
// WRONG
import { BrowserRouter } from 'react-router-dom';
```

Routes: `/` (Dashboard), `/chat`, `/chat/*`, `/workflows`, `/workflows/builder`, `/workflows/runs/:runId`, `/settings`.

## API Client Pattern

```typescript
// src/lib/api.ts exports SSE_BASE_URL and REST functions
import { SSE_BASE_URL } from '@/lib/api';
// In dev: Vite proxies /api/* to localhost:{VITE_API_PORT}
// API port injected at build time: import.meta.env.VITE_API_PORT
```

TanStack Query `staleTime: 10_000`, `refetchOnWindowFocus: true`.

## Anti-patterns

- Never add a light mode — dark-only is intentional
- Never use `react-router-dom` — use `react-router` (v7)
- Never configure Tailwind in `tailwind.config.js/ts` — v4 is CSS-first
- Never use `tailwindcss-animate` — use `tw-animate-css`
- Never open a second `EventSource` per conversation — `useSSE()` handles it
- Never pass inline style objects for theme colors — use Tailwind classes with CSS variables
