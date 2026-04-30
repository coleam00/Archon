# Symphony (TypeScript)

A long-running automation service that polls a Linear-compatible issue tracker, creates per-issue workspaces, and runs Codex coding-agent sessions inside them. Driven by an in-repo `WORKFLOW.md` file.

This implementation targets the [Symphony Service Specification](https://github.com/openai/symphony/blob/main/SPEC.md) — REQUIRED conformance plus the OPTIONAL HTTP API. The SSH worker extension is not included.

## Quick start

```sh
pnpm install
cp WORKFLOW.example.md WORKFLOW.md
# edit WORKFLOW.md, set tracker.api_key (or export LINEAR_API_KEY) and tracker.project_slug
export LINEAR_API_KEY=...
pnpm dev                       # uses ./WORKFLOW.md by default
pnpm dev path/to/WORKFLOW.md   # explicit path
pnpm dev --port 4000           # also start the optional dashboard at http://127.0.0.1:4000/
```

## Scripts

- `pnpm dev` — run via `tsx` without building.
- `pnpm build` — emit `dist/`.
- `pnpm start` — run the built artifact.
- `pnpm test` — vitest unit + integration suite.
- `pnpm typecheck` — `tsc --noEmit`.

## Workflow file

`WORKFLOW.md` is Markdown with optional YAML front matter. The body is the prompt template (Liquid syntax, strict). See `WORKFLOW.example.md` for a reference.

## HTTP API (optional)

When `--port` is provided (or `server.port` is set in front matter) the service serves:

- `GET /` — minimal HTML dashboard.
- `GET /api/v1/state` — running, retrying, codex_totals, rate_limits.
- `GET /api/v1/<issue_identifier>` — issue-specific runtime details, `404` if unknown.
- `POST /api/v1/refresh` — queue an immediate poll + reconcile cycle.

## Status

Implementation in progress; see `/Users/desha/.claude/plans/implement-this-spec-in-typed-oasis.md` for the build plan.
