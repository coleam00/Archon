---
description: "Set up source development and run the Bun workspace services"
agent: "agent"
tools:
  - runInTerminal
  - readFile
---

# Set up source development

Use this prompt for a repository checkout. For binary installation, follow the
installation documentation instead.

## Set up and run

1. Work from the repository root. Read `CONTRIBUTING.md`, the root `package.json`,
   and `.env.example` for the current setup requirements. Use the Bun version
   specified in `package.json`.
2. Install workspace dependencies: `bun install --frozen-lockfile`.
3. If `.env` does not exist, copy `.env.example` to `.env` and configure it for the
   intended local setup. Preserve an existing `.env` and never print secret values.
4. Start development from the root with `bun run dev` in a persistent terminal.
   The root launcher in `scripts/dev.ts` starts the workspace `dev` scripts: the
   API server, Web UI (Vite), and documentation site (Astro). Keep the startup
   output available for verification and troubleshooting.

## Verify

Use startup output and HTTP responses to establish readiness, without a fixed
startup sleep. Retry checks while startup is progressing; if a service fails or
does not become ready within a bounded wait, report its error rather than claiming
success.

- API: use the bound port reported by the server and request `/api/health` with
  `curl --fail --show-error`. Confirm a successful response with `status: "ok"`.
  The root launcher selects the API port and passes it to the server and Vite
  proxy; do not assume a fixed API port, especially in a worktree.
- Web UI: request the local URL printed by Vite and confirm it serves the UI HTML.
  Also request `/api/health` through that URL to verify the API proxy.
- Documentation: request the local URL printed by Astro and confirm it serves
  the documentation HTML.

## Report

Report concisely:

- Setup performed and any configuration still needed, without secret values.
- Actual API, Web UI, and documentation URLs and the result of each check.
- Any startup errors or failed checks, and whether the development process is
  still running.
