# Recommended Workflows — Design Spec

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation plan
**Scope:** Single feature, single implementation plan

## Problem

When a project is selected in the Web UI, every workflow (bundled, global, project) appears in one flat, unordered list — both in the **Workflows page** grid (`WorkflowList.tsx`) and the **sidebar run dropdown** (`WorkflowInvoker.tsx`). A repo owner has no way to tell users of their project *"these are the workflows you should use here."* Users must know which of the dozens of workflows are relevant to this specific codebase.

## Goal

Let the **repo owner** curate an **ordered list of recommended workflows** that lives **inside the cloned project's own repo** (not in Archon's storage), and surface those workflows **pinned on top** of both UI surfaces under a header, separated from the rest by a divider.

### Non-goals (YAGNI)

- Per-user personal favourites (no DB, no per-user state). This is repo-owner-curated and shared.
- Configurable header text.
- Storing the list anywhere outside the cloned project repo.
- Changing workflow-YAML files (those are instance-wide) or Archon's global config.

## Key decision: where the list lives

The list lives in the **cloned project's** `<repo>/.archon/config.yaml` under a new `recommendedWorkflows` key.

Rationale (decided during brainstorming):

- `.archon/config.yaml` is the **per-repo** Archon config — *not* Archon-source-only. Any codebase Archon manages can have its own `<repo>/.archon/config.yaml`, and it is already read per-cloned-project by `discoverWorkflowsWithConfig(cwd, loadConfig)`.
- The list travels with the repo, is checked in, and is repo-owner-controlled — exactly the requirement.
- Rejected alternatives: per-workflow `recommended: true` flag (workflow files are instance-wide, can't curate bundled defaults, no ordering); parsing `CLAUDE.md` (fragile, pollutes an AI-instructions doc with UI config).

## Declaration format

`<repo>/.archon/config.yaml`:

```yaml
recommendedWorkflows:
  - archon-fix-github-issue
  - archon-idea-to-pr
  - archon-plan
```

Semantics:

- **List order = pin order** in both UI surfaces.
- Each entry is a **workflow name** (matched against the discovered set: bundled + global + project).
- A name that matches **no** discovered workflow is **silently ignored** (debug-level log, not an error — the list is advisory, a stale entry must not break discovery).
- Key **absent or empty** → behaves exactly as today: flat list, no header, no divider. **Zero-config safe.**

## Architecture / data flow

```
.archon/config.yaml (cloned project)
        │  recommendedWorkflows: [...]
        ▼
config-loader.ts  ──►  RepoConfig.recommendedWorkflows?: string[]
        │
        ▼
GET /api/workflows handler (api.ts)
   - discoverWorkflowsWithConfig(workingDir, loadConfig)  → workflows
   - loadConfig(workingDir)                               → recommendedWorkflows
   - filter recommended to names present in discovered set, preserve order
        │
        ▼  { workflows: [{workflow, source}], recommended: string[], errors? }
        ▼
web lib/api.ts  listWorkflows(cwd) → { workflows, recommended }
        │
        ├──►  WorkflowList.tsx   (partition: pinned header + divider + rest)
        └──►  WorkflowInvoker.tsx (<optgroup> Recommended / Other)
```

## Components and changes

Touch-set (scope-guarded — no unrelated refactor of these files):

### 1. Config types — `packages/core/src/config/config-types.ts`
- Add `recommendedWorkflows?: string[]` to the `RepoConfig` interface.
- **Not** added to `GlobalConfig` or `MergedConfig` — it is inherently per-project and read directly from repo config at the API layer.

### 2. Config loader — `packages/core/src/config/config-loader.ts`
- Parse `recommendedWorkflows` from repo `.archon/config.yaml` into `RepoConfig`.
- Defensive: ignore non-array / non-string values rather than throwing (advisory data).

### 3. API route — `packages/server/src/routes/api.ts` (`GET /api/workflows`)
- After discovery resolves `workingDir`, read project config (`loadConfig(workingDir)`) to obtain `recommendedWorkflows`.
- Build `recommended: string[]` = declared names ∩ discovered workflow names, in **declared order**. Empty `[]` when no project context or no key.
- Add `recommended` to the JSON response alongside `workflows` and `errors`.

### 4. Route response schema — `packages/server/src/routes/schemas/` (workflow domain)
- Extend the `GET /api/workflows` Zod response schema with `recommended: z.array(z.string())`.
- Regenerate web types: `bun --filter @archon/web generate:types` (server must be running on port 3090).

### 5. Web API client — `packages/web/src/lib/api.ts`
- Change `listWorkflows(cwd)` to return `{ workflows, recommended }` (currently returns the bare workflows array). Both consumers are updated in the same change.

### 6. Workflows page — `packages/web/src/components/workflows/WorkflowList.tsx`
- Partition the **already-filtered** workflow list into:
  - **recommended** — those whose name is in `recommended`, ordered by `recommended`'s order;
  - **rest** — everything else, current ordering preserved.
- Render a **"Recommended for this project"** header above the recommended cards, a divider, then the rest grid.
- Search + category filters apply to **both** partitions. If filtering hides all recommended cards, the header is not rendered (no empty section).
- No new filter state; partition is derived in the existing `useMemo` chain.

### 7. Sidebar dropdown — `packages/web/src/components/sidebar/WorkflowInvoker.tsx`
- When `recommended.length > 0`, render two native `<optgroup>` blocks: `Recommended` (pinned, declared order) and `Other workflows` (rest). Otherwise keep the current flat option list.

### 8. Tests
- Config loader: parses `recommendedWorkflows`; tolerates missing/malformed values.
- API: `GET /api/workflows` returns `recommended` filtered to existing names in declared order; empty when no project/key.
- Web: partition logic produces correct pinned/rest split, including the "all recommended filtered out" case.

### 9. Docs
- Document `recommendedWorkflows` in the repo-config reference under `packages/docs-web/`.

## Error handling

- Stale / unknown workflow names in the list: ignored, debug log. Never fails discovery or the API.
- Malformed `recommendedWorkflows` (not an array of strings): coerced to empty / ignored at parse time, debug log. No throw.
- No project context (no `cwd`, no registered codebase): `recommended = []`; both surfaces fall back to flat rendering.

## Testing strategy

- Unit: config parse (valid, missing, malformed); API filtering/ordering; web partition.
- Manual: register a project, add `recommendedWorkflows` to its `.archon/config.yaml`, confirm both surfaces pin the listed workflows in order with header + divider, and that removing the key restores the flat list.

## Decisions baked in

- **Header text** fixed at `"Recommended for this project"` (not configurable — YAGNI).
- **Recommended section respects search/category filters** (consistency) rather than always showing regardless of filters.
