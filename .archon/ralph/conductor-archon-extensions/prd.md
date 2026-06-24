# Conductor Archon Extensions — Product Requirements

## Overview

**Problem**: Archon's chat is a vanilla LLM with no personality, no knowledge of specialist "gods," and no way to receive external webhook triggers or import workflows from n8n. To serve as the engine for Conductor (the operator-facing application), Archon needs three additions: (1) a god-registry system so the prompt-builder can teach the chat who the specialists are and when to dispatch to them, (2) a webhook DAG node type so workflows can pause and wait for external events (Zapier/n8n parity), and (3) an n8n→Archon converter so operators can migrate existing automation pipelines.
**Solution**: Extend `prompt-builder.ts` with a god-registry section sourced from config, add a `webhook:` DAG node type with HTTP receiver and executor support, and ship an n8n JSON→Archon YAML converter accessible via CLI and REST.
**Branch**: `ralph/conductor-archon-extensions`

---

## Goals & Success

### Primary Goal
Give Archon the three Conductor-specific engine primitives: god-aware system prompts, webhook-triggered DAG nodes, and n8n workflow import.

### Success Metrics
| Metric | Target | How Measured |
|--------|--------|--------------|
| God registry visible in system prompt | Any god in config appears in prompt | Unit test `formatGodsSection()` |
| Webhook node pauses workflow | Run enters `paused` state on webhook node | Integration: workflow runs + event check |
| n8n converter round-trips | Reference n8n JSON produces valid Archon YAML | Unit test with fixture |
| Type-check clean | Zero tsc errors | `bun run type-check` |
| All tests pass | Zero failures | `bun run test` |

### Non-Goals (Out of Scope)
- Athenaeum / Ichor integration — external systems, separate repo
- Mobile UI — pure frontend, separate PR (`CONDUCTOR-MOBILE-UI-SPEC.md`)
- Kanban view — frontend-only, separate PR
- codebase-memory-mcp installation — external binary, documented separately
- Conductor application UI — operator-facing shell around Archon, separate repo

---

## User & Context

### Target User
- **Who**: Konan, operator / solo developer using Archon as the backbone of the Conductor workflow automation platform
- **Role**: Designs and runs multi-step AI workflows. Talks to "Conductor" (a chat assistant) to dispatch specialist gods (Thoth, Hephaestus, Rheta) to their tasks.
- **Current Pain**: Chat has no idea who the specialist gods are. Workflows can't pause and wait for external triggers. n8n workflows require manual translation.

### User Journey
1. **God registry**: User adds a `gods:` section to `.archon/config.yaml`. Chat assistant immediately begins dispatching to the right workflow based on the god roster.
2. **Webhook node**: User writes a workflow YAML with a `webhook:` node. Archon pauses the run at that node and logs a trigger URL. External system (Zapier, n8n, GitHub Actions) POSTs to that URL. Run resumes.
3. **n8n import**: User runs `archon workflow import n8n my-flow.json`. Archon writes `my-flow.yaml` to `.archon/workflows/`. User reviews, adjusts, runs.

---

## UX Requirements

### Interaction Model

**God registry**: Declarative YAML in global `~/.archon/config.yaml` or repo `.archon/config.yaml`. No new commands needed — it's a config section.

**Webhook node**: YAML `webhook:` key in a workflow node. On reach, Archon prints/logs a URL like `POST /webhooks/workflow/<runId>/<nodeId>`. Caller POSTs any JSON payload. Node captures payload as `$nodeId.output`.

**n8n import**:
- CLI: `archon workflow import n8n <file.json> [--out <name>] [--cwd <path>]`
- REST: `POST /api/workflows/import/n8n` body: n8n JSON, returns `{ yaml: string, warnings: string[] }`

### States to Handle
| State | Description | Behavior |
|-------|-------------|----------|
| No gods configured | `gods:` absent from config | `formatGodsSection()` returns `''`; prompt unchanged |
| God with no workflows | God entry has empty `workflows:[]` | Shown in prompt but no dispatch instructions |
| Webhook timeout | No POST before `timeout` ms | Node fails with `WebhookTimeoutError`; workflow fails |
| Invalid n8n JSON | Malformed or unrecognized schema | Converter returns structured error list, no file written |
| n8n node type unmapped | n8n node type with no Archon equivalent | Converted to `bash:` stub with `# TODO` comment; warning emitted |

---

## Technical Context

### Patterns to Follow
- **Config type extension**: `packages/core/src/config/config-types.ts:66-133` — `GlobalConfig` and `RepoConfig` interfaces. Add optional `gods?: GodDefinition[]` to both, add required `gods: GodDefinition[]` (defaulting `[]`) to `MergedConfig`.
- **Prompt-builder section**: `packages/core/src/orchestrator/prompt-builder.ts:12-38` — `formatProjectSection()` and `formatWorkflowSection()` are the exact pattern to mirror for `formatGodsSection()`.
- **Bundled defaults**: `.archon/commands/defaults/*.md` — new conductor persona file follows same format. After adding, run `bun run generate:bundled`.
- **DAG node schema**: `packages/workflows/src/schemas/dag-node.ts:1-100` — flat raw schema + `superRefine` mutual-exclusivity validation. Add `webhook?: WebhookNodeConfig` to the raw schema and a new branch in `superRefine`.
- **Approval node pause pattern**: Approval nodes pause the workflow by the executor storing a `paused` state and polling workflow events — `WebhookNode` mirrors this pattern exactly (see `dag-executor.ts` for the approval node branch).
- **OpenAPI route registration**: `packages/server/src/routes/api.ts` — use `registerOpenApiRoute(createRoute({...}), handler)` for the import endpoint.
- **CLI subcommand**: `packages/cli/src/commands/workflow.ts` — add `import` subcommand to the workflow command group, following the same option-parsing style as `workflowListCommand`.

### Types & Interfaces
```typescript
// God registry entry (config-types.ts)
export interface GodDefinition {
  id: string;                    // Unique identifier (e.g. 'thoth')
  displayName: string;           // Human name (e.g. 'Thoth')
  description: string;           // One-line role description
  workflows?: string[];          // Archon workflow names to dispatch to
}

// WebhookNode config (dag-node.ts)
export interface WebhookNodeConfig {
  message?: string;              // Instructions shown when waiting
  timeout?: number;              // ms before timeout (default: 1 hour)
}

// n8n converter output (n8n-converter.ts)
export interface ConversionResult {
  workflow: WorkflowDefinition;
  warnings: string[];
}
```

### Architecture Notes
- `GodDefinition[]` lives in both `GlobalConfig` and `RepoConfig`; `MergedConfig` merges them (repo overrides global by `id`).
- `formatGodsSection()` returns `''` when no gods are configured — the existing `buildOrchestratorPrompt()` only includes it when non-empty (mirrors `formatWorkflowContextSection()` at line 52).
- WebhookNode uses the same pause/resume event flow as ApprovalNode. The webhook receiver endpoint (`POST /webhooks/workflow/:runId/:nodeId`) stores a `webhook_triggered` event in `workflow_events`, then the executor polling loop picks it up.
- The n8n converter is a pure function (no I/O) — the CLI and REST endpoint are thin wrappers. Node type mapping table lives in `n8n-converter.ts`.

---

## Implementation Summary

### Story Overview
| ID | Title | Priority | Dependencies |
|----|-------|----------|--------------|
| US-001 | God registry config types | 1 | — |
| US-002 | `formatGodsSection()` and prompt-builder integration | 2 | US-001 |
| US-003 | Conductor persona bundled default command | 3 | — |
| US-004 | `WebhookNode` Zod schema | 4 | — |
| US-005 | Webhook HTTP receiver endpoint + executor support | 5 | US-004 |
| US-006 | n8n-to-Archon converter utility | 6 | — |
| US-007 | `archon workflow import n8n` CLI command + REST endpoint | 7 | US-006 |

### Dependency Graph
```
US-001 (config types)
    ↓
US-002 (prompt-builder)

US-003 (persona file) — independent

US-004 (webhook schema)
    ↓
US-005 (webhook receiver + executor)

US-006 (n8n converter)
    ↓
US-007 (import CLI + REST)
```

---

## Validation Requirements

Every story must pass:
- [ ] Type-check: `bun run type-check`
- [ ] Lint: `bun run lint`
- [ ] Tests: `bun run test`
- [ ] Format: `bun run format:check`
- [ ] Full validate: `bun run validate` (includes bundled-defaults check)

---

*Generated: 2026-06-24T00:00:00Z*
