## Learned User Preferences

## Learned Workspace Facts

- Run `bun install` from the repo root before `bun run dev` or per-package dev scripts; without a linked root `node_modules`, workspace packages are not resolved and common failures include missing `vite`/`astro` and failed `@archon/paths` subpath imports (for example `@archon/paths/strip-cwd-env-boot` from `@archon/server`).
- In the Web UI, Settings → Platform Connections hardcodes Slack, Telegram, Discord, and GitHub as not connected; only Web reflects live adapter state, so a working Slack bot can still show as not configured there until the UI is wired to real platform status.
