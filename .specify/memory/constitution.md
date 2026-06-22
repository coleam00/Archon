<!--
Sync Impact Report
Version change: TEMPLATE -> 1.0.0
Modified principles:
- Template PRINCIPLE_1_NAME -> I. Single-Developer Simplicity
- Template PRINCIPLE_2_NAME -> II. Platform and Provider Boundaries
- Template PRINCIPLE_3_NAME -> III. Type-Safe Contracts and Schemas
- Template PRINCIPLE_4_NAME -> IV. Deterministic Workflows and Reproducible Validation
- Template PRINCIPLE_5_NAME -> V. Git-Owned Isolation and Lifecycle Safety
- Added VI. Explicit Errors, Observability, and Secret Hygiene
Added sections:
- Operational Constraints
- Development Workflow and Quality Gates
Removed sections:
- None; template placeholders were replaced with project-specific sections.
Templates requiring updates:
- ✅ updated .specify/templates/plan-template.md
- ✅ updated .specify/templates/spec-template.md
- ✅ updated .specify/templates/tasks-template.md
- ✅ updated AGENTS.md
- ✅ updated CLAUDE.md
- ✅ no action needed .specify/templates/commands/*.md (directory absent)
Follow-up TODOs:
- None
-->

# Archon Constitution

## Core Principles

### I. Single-Developer Simplicity

Archon MUST remain optimized for a single-developer operating model unless an
accepted feature explicitly expands scope. New work MUST avoid multi-tenant
policy, resource visibility matrices, and role systems beyond the existing
open-by-default admin/member seam. Unsupported paths MUST fail with explicit
errors instead of partial fake support.

Rationale: Archon's value is local control and low operational complexity;
speculative tenancy adds risk without current user value.

### II. Platform and Provider Boundaries

All external conversation surfaces MUST integrate through `IPlatformAdapter`,
and platform authorization parsing/checks MUST stay inside each adapter. AI
runtimes MUST integrate through `IAgentProvider` or the provider registry.
SDK-specific dependencies MUST stay in `@archon/providers`; workflow-facing
contracts MUST come from `@archon/providers/types`. The workflow engine MUST
receive database, AI, and config behavior through `WorkflowDeps` and MUST NOT
import `@archon/core`, `@archon/server`, or adapter packages directly.
`@archon/web` MUST consume OpenAPI-derived types from its API layer instead of
importing server or workflow-engine packages.

Rationale: remote channels and agent runtimes change often; narrow boundaries
preserve portability, testability, and replaceability.

### III. Type-Safe Contracts and Schemas

All TypeScript changes MUST satisfy strict compiler settings with complete
function annotations and no `any` unless an inline comment names the external
type gap or validated assertion. Zod schemas MUST use camelCase names, derive
TypeScript types with `z.infer<typeof schema>`, use explicit
`z.record(z.string(), valueSchema)`, and import `z` from `@hono/zod-openapi`
except SDK-only leaf schemas in `@archon/providers`. JSON API routes MUST use
`registerOpenApiRoute(createRoute({...}), handler)` except documented raw
wildcard or multipart/manual-parsing exceptions. Runtime enum arrays MUST
derive from schema `.options` when available.

Rationale: Archon's API, web client, database rows, and workflow engine depend
on generated contracts staying synchronized.

### IV. Deterministic Workflows and Reproducible Validation

Workflow definitions MUST keep deterministic work in `bash`, `script`, and
`approval` nodes and use AI nodes only where judgment is required. New workflow
capabilities MUST validate YAML at load time, preserve DAG dependency checks,
and make structured output validation fail loudly for every provider. Generated
artifacts, bundled defaults, embedded schema, and Pi vendor maps MUST be
regenerated when their sources change. `bun run validate` MUST remain the
pre-PR gate and map to CI; tests MUST run through package-isolated scripts,
never root `bun test`.

Rationale: Archon's promise is repeatable AI coding, so workflow order,
generated files, and tests must be reproducible.

### V. Git-Owned Isolation and Lifecycle Safety

Git operations MUST use `@archon/git` helpers or `execFileAsync` for direct git
calls, surface actionable git errors, and rely on git's natural guardrails for
conflicts and dirty worktrees. Worktree isolation MUST remain the default for
workflow implementation unless the user explicitly opts out. Code MUST NOT run
`git clean -fd` or silently discard user work. Processes MUST NOT
autonomously mark non-terminal workflow runs or environments as failed,
cancelled, destroyed, or abandoned when ownership is ambiguous across CLI,
adapter, webhook, web UI, cron, or another process; they MUST surface the
ambiguous state and provide an explicit user action.

Rationale: Archon coordinates long-running work across processes, and
destructive guesses can erase or misrepresent live user work.

### VI. Explicit Errors, Observability, and Secret Hygiene

Unsupported states, invalid provider identities, schema-validation failures,
auth boundary failures, and missing required dependencies MUST throw or return
clear classified errors. Intentional fallback behavior MUST be documented where
it is implemented. Logs MUST use structured Pino events named
`{domain}.{action}_{state}`, pair `_started` with `_completed` or `_failed`,
and include enough IDs and durations for diagnosis. Logs, telemetry, API
responses, artifacts, and UI state MUST NOT expose tokens, API keys, user
message content, prompts, PII, git remotes, file paths, or raw error text where
the telemetry contract excludes them. Webhooks MUST verify signatures, and
`/internal/*` credential endpoints MUST stay loopback-only unless an explicit
deployment guard is in place.

Rationale: agent runtimes can spend money, mutate repositories, and handle
credentials; quiet failure and broad logging are unsafe.

## Operational Constraints

Archon is a Bun and TypeScript monorepo using SQLite by default and PostgreSQL
when `DATABASE_URL` is present. New packages MUST preserve the existing layer
dependencies: `@archon/paths` has no `@archon/*` dependencies, `@archon/git`
depends only on paths, `@archon/isolation` depends only on git and paths,
`@archon/workflows` depends only on git, paths, provider contracts, and schema
libraries, and SDK dependencies stay in `@archon/providers`.

Core row schemas live in `packages/core/src/schemas/`, route schemas live in
`packages/server/src/routes/schemas/`, and engine schemas live in
`packages/workflows/src/schemas/`. Any schema, OpenAPI route, workflow
definition, bundled default, migration, or provider catalog change MUST update
its generated artifact or generated web type in the same change when the
project command requires it.

UI changes in `packages/web/`, experiments, documentation, marketing surfaces,
or future visual surfaces MUST reuse Archon brand tokens and established design
system primitives. New colors, typography, spacing, radius, or visual tokens
MUST update the token source and brand guide in the same change.

## Development Workflow and Quality Gates

Feature work MUST branch from `dev` and merge back into `dev`; `main` is the
release branch and MUST NOT receive direct feature commits. Pull requests MUST
use `.github/PULL_REQUEST_TEMPLATE.md`, fill every section, and link issues
with `Closes`, `Fixes`, or `Resolves` when applicable. Releases MUST use the
release workflow, follow Semantic Versioning, update the root `package.json`
version, and maintain `CHANGELOG.md` in Keep a Changelog format.

Before PR creation, `bun run validate` MUST pass. This includes bundled default
checks, bundled skill checks, bundled schema checks, Pi vendor map checks,
type-checking, lint with zero warnings, format checking, and package-isolated
tests. Contributors MUST NOT run root `bun test` as the validation signal
because it mixes process-global `mock.module()` state across packages.

Implementation plans MUST document the Constitution Check before Phase 0
research and re-check it after Phase 1 design. Any violation MUST have a
specific accepted use case, a rejected simpler alternative, and a rollback path.

## Governance

This constitution governs spec-kit specifications, implementation plans, task
generation, and project guidance. When it conflicts with generated templates,
AGENTS.md, CLAUDE.md, or workflow guidance, this constitution takes precedence
and the dependent artifact MUST be updated in the same change.

Amendments MUST use the constitution update process, include a Sync Impact
Report, update dependent templates and runtime guidance, and preserve ISO
dates. Versioning follows Semantic Versioning: MAJOR for principle removals or
backward-incompatible redefinitions, MINOR for new principles, sections, or
materially expanded gates, and PATCH for clarifications that do not change
required behavior.

Compliance review is mandatory during planning, code review, and release
preparation. Reviewers MUST verify package boundaries, type/schema contracts,
validation commands, git lifecycle safety, observability, and secret handling
for any affected area. Unresolved constitutional violations block PR readiness.

**Version**: 1.0.0 | **Ratified**: 2026-06-21 | **Last Amended**: 2026-06-21
