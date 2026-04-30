# symphoney-legacy

Reference snapshot of `Ddell12/symphoney-codex` (the standalone TypeScript Symphony daemon) as of **2026-04-30**, captured before that repo is archived. Phase 2–4 of the consolidation port code from this snapshot into `packages/symphony/`; once Phase 5 lands and `symphoney-codex` is deleted, this directory is the only remaining record of the pre-fork codebase.

## What's here

- **`plans/2026-04-30-archon-symphony-consolidation.md`** — master 6-phase consolidation plan. Phases 0–1 already shipped; Phase 2 onward consumes this.
- **`incidents/2026-04-30-app-273-data-loss.md`** — incident report for the reconcile-terminal data-loss bug fixed in Phase 0 (commit `fa70be2` in `symphoney-codex`, dogfood-verified via APP-291).
- **`SPEC.md`** — OpenAI's canonical Symphony Service Specification. Source of truth for tracker/orchestrator/agent semantics; symphoney-codex's source files reference it by line number (e.g. `SPEC.md:633-634` in `runWorker`).
- **`WORKFLOW.md`** — the production daemon's runtime config (YAML front matter + Liquid prompt). Phase 2 turns this into `~/.archon/symphony.yaml` (no `agent:` block; per-state `workflow:` key).
- **`WORKFLOW.example.md`** — sample/template config.
- **`PARITY_REPORT.md`** — gap analysis vs OpenAI's Elixir reference impl. Phase 5 appends a "deprecated in favor of archon-symphony" section.
- **`ROADMAP.md`**, **`WEB_GAPS.md`**, **`PRD.md`** — broader product/engineering context.
- **`CLAUDE.md`** — symphoney-codex's architecture reference (the ESM/`.js`-imports/`pool: forks`/etc. conventions). Phase 2 should consult this when porting orchestrator + tracker.
- **`symphoney-readme.md`** — top-level README.
- **`src/`** — full source snapshot. Phase 2 ports `tracker/`, `orchestrator/`, `config/snapshot.ts`, `workflow/parse.ts` into `packages/symphony/src/`. `publisher/pr.ts` and `agent/linear-graphql-tool.ts` may also port (Phase 3 decides). `agent/{stdio-client,claude-client,claude-adapter,fake-client}.ts` and `agent/factory.ts` are NOT ported — Archon's `packages/providers/` already covers these. `server/http.ts` and `server/dashboard.ts` are NOT ported — Archon's `packages/server/` owns the HTTP layer.
- **`test/`** — full test snapshot. Patterns to mirror: `test/integration/orchestrator.test.ts` (polling + dispatch + retry), `test/integration/orchestrator-reconcile-publish.test.ts` (Phase 0 publish-before-remove tests), `test/helpers/fake-tracker.ts`. Tests use `vitest`; archon uses `bun:test` — port the patterns, not the syntax.
- **`scripts/smoke-claude.ts`**, **`scripts/smoke-linear-graphql.ts`** — real-API smoke scripts. Useful as references for Phase 2's tracker validation; archon has its own provider smoke scripts so don't port directly.

## What's NOT here (intentionally)

- `node_modules/`, `dist/`, `pnpm-lock.yaml`, `package.json`, `tsconfig.json`, `vitest.config.ts` — pnpm/Vitest mechanics. Archon uses Bun.
- `web/` — the Next.js kanban being retired. Phase 4 ports its grouping/transform helpers into `packages/web/src/components/symphony/` directly from the live source while symphoney-codex still exists.
- `bin/symphony` — symphoney's CLI entry point. Archon owns its own CLI.
- `.env` — credentials. Use `~/.archon/symphony.yaml` + your local `.env` instead.

## Stable artifact warning

This snapshot is **frozen at the point it was committed**. If any of these files materially diverge in symphoney-codex before that repo is archived, the user is responsible for re-syncing. The plan file in particular gets edited as phases land — keep the symphoney-codex copy authoritative until Phase 5.
