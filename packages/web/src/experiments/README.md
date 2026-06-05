# experiments/

Staging area for in-repo spikes and prototypes.

Rules:

- Not part of the shipped product. CI does not guarantee these routes work end-to-end, though unit tests for experiment primitives that opt in (e.g. `console/`, wired into the web `test` script) do run in CI.
- Each experiment lives in its own folder and mounts under a dedicated route so it cannot affect production surfaces.
- Does not import from `packages/web/src/components/`, `stores/`, `contexts/`, `routes/`, or `hooks/`. Shared types come from `@/lib/api.generated` only. This decoupling is the point — experiments have to prove they can stand on their own before they replace anything.
- If an experiment becomes the product: extract it into its own workspace package or replace the existing surface. Don't let experiments accrete indefinitely.

Current experiments:

- `console/` — greenfield rebuild of the web UI around the 4-primitive mental model (Project, Run, Workflow, Worktree). Mounted at `/console`.
