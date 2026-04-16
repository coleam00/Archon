# Console (spike)

A greenfield spike of Archon's web UI built around four primitives:

- **Project · Run · Workflow · Worktree**

Mounted at `/console/*`. Not part of the shipped product. Validates the mental model before any migration. If dogfooding succeeds, extract to `packages/console` and begin replacing production surfaces. If it fails, we learn cheaply.

## Routes

- `/console` → Runs view (scope = `all`)
- `/console/p/:projectId` → Runs view scoped to a project
- `/console/p/:projectId/r/:runId` → Run detail

## Constraints

- **Isolated.** Forbidden imports from `packages/web/src/{components,stores,contexts,routes,hooks}` and `@tanstack/react-query`, `@/lib/api` (function exports). Enforced by ESLint. Type-only imports from `@/lib/api.generated` are allowed.
- **Skill API is the single mutation surface.** Every UI action calls one skill verb. See `skills/`.
- **Design tokens reused.** Uses the oklch semantic tokens from `packages/web/src/index.css` (`bg-surface`, `text-text-primary`, `bg-success`, `bg-warning`, `bg-error`, etc.).
- **Vocabulary.** Only *Project, Run, Workflow, Worktree* appear in user-facing copy. No *Dashboard, Deployment, Infrastructure, Secrets, Activity, Pipeline, Stage*.

## Plan

See `/Users/rasmus/.claude/plans/quiet-twirling-bentley.md` for the full E2E plan and milestones.
