## Rebase-onto-dev addendum (2026-08-19)

Rebasing `fix/parallel-shared-context-session` onto `dev` produced a real conflict in
`isFreshSequential`'s definition: `dev` had independently added a third fresh-session case
(`composedBlockEntry`, #1764 — a composed workflow's entry node forces a fresh session
unless it opts out via `context: 'shared'`) on the exact same line this fix changes. The two
are orthogonal — this fix's `(isParallelLayer && node.context !== 'shared')` term governs
parallel-layer siblings, `composedBlockEntry` governs a single composed-block entry node —
so the conflict was resolved by `||`-combining all three terms rather than picking a side:

```ts
const composedBlockEntry = readComposedMeta(node)?.blockEntry === true && node.context !== 'shared';
const isFreshSequential =
  node.context === 'fresh' || (isParallelLayer && node.context !== 'shared') || composedBlockEntry;
```

The "Architecture Diagram → After" section below still describes this fix's own two-term
formula in isolation — accurate for any non-composed node, since `composedBlockEntry` is
`false` there and drops out of the `||` chain. `dag-executor.test.ts`'s full suite is
499/499 passing post-rebase (up from the 451/451 recorded below — dev's own composed-block
and other work added coverage in between).

## Summary

- Problem: `context: 'shared'` is a documented DAG-node field meant to override a parallel
  layer's default of a fresh AI session per sibling, forcing one sibling to resume the
  session left by the node that fed the layer. In `runLayers()`
  (`packages/workflows/src/dag-executor.ts`), the sequential-session cursor
  (`ctx.lastSequentialSession`) was wiped at the _start_ of every parallel layer — before any
  node could read it — and the freshness predicate never checked for `'shared'` at all. The
  setting parsed and validated but had zero runtime effect: no warning, no error, just a
  fresh session every time.
- Why it matters: any workflow author using `context: 'shared'` inside a parallel layer got
  silently wrong behavior with no signal anything was off.
- What changed: in `runLayers()`, moved the parallel-layer cursor reset from before to after
  the layer's node dispatch, and added a `node.context !== 'shared'` carve-out to the
  freshness predicate. Two-line logic change plus one new regression test.
- What did **not** change (scope boundary): sequential-layer session threading (already
  correct), the cross-provider guard (#1992), loop/loop_group session semantics
  (`fresh_context` — a separate, intentionally different and already-warned mechanism), and
  no schema/YAML surface change.

## UX Journey

### Before

```
Workflow author                 Engine (runLayers)
────────────────                 ──────────────────
writes:
  - id: a
    prompt: ...
  - id: b
    depends_on: [a]
    context: shared   ──▶   layer [b, c] is parallel (len > 1)
  - id: c                    ctx.lastSequentialSession reset to undefined
    depends_on: [a]           BEFORE b/c dispatch                    [!]
                              isFreshSequential = isParallelLayer
                                (true regardless of node.context)    [!]
                              b runs with a FRESH session — sess-a lost
                              (identical to c, despite `context: shared`)
```

### After

```
Workflow author                 Engine (runLayers)
────────────────                 ──────────────────
writes:
  - id: a
    prompt: ...
  - id: b
    depends_on: [a]
    context: shared   ──▶   layer [b, c] is parallel
  - id: c                    cursor still holds sess-a when b/c dispatch [+]
    depends_on: [a]          b: isFreshSequential = false
                                (context: 'shared' overrides parallel default) [+]
                                → resumes sess-a (same-provider guard still applies)
                              c: isFreshSequential = true (unchanged) → fresh
                              AFTER dispatch: cursor reset to undefined
                                (still can't hand ONE cursor to the next layer)
```

## Architecture Diagram

### Before

```
runLayers()
  for each layer:
    isParallelLayer = layer.length > 1
    if (isParallelLayer): ctx.lastSequentialSession = undefined   [reset BEFORE dispatch]
        │
        ▼
    Promise.allSettled(layer.map(node => {
      isFreshSequential = isParallelLayer || node.context === 'fresh'  [no 'shared' check]
      cursor = ctx.lastSequentialSession    // already undefined in a parallel layer
      resumeSessionId = isFreshSequential ? undefined : cursor?.sessionId
    }))
```

### After

```
runLayers()
  for each layer:
    isParallelLayer = layer.length > 1
        │
        ▼
    Promise.allSettled(layer.map(node => {
      isFreshSequential =
        node.context === 'fresh' || (isParallelLayer && node.context !== 'shared')  [~]
      cursor = ctx.lastSequentialSession    // still holds the pre-layer value
      resumeSessionId = isFreshSequential ? undefined : cursor?.sessionId
    }))
        │
        ▼
    if (isParallelLayer): ctx.lastSequentialSession = undefined   [~ reset moved AFTER dispatch]
```

**Connection inventory:**

| From                                                             | To                          | Status         | Notes                                                                                                           |
| ---------------------------------------------------------------- | --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `runLayers()` parallel-layer cursor reset                        | `ctx.lastSequentialSession` | **modified**   | Moved from before to after `Promise.allSettled` dispatch                                                        |
| `runLayers()` per-node `isFreshSequential`                       | `node.context`              | **modified**   | Added `node.context !== 'shared'` carve-out inside the `isParallelLayer` branch                                 |
| `executeLoopGroupNode()` per-iteration body (`runLayers` caller) | `runLayers()`               | **unaffected** | Same shared function — benefits automatically, no separate change needed                                        |
| `isPersistableNode()` / `loader.ts` persist_session validation   | `node.context === 'fresh'`  | **unaffected** | Different concern (cross-run persistence); confirmed correct, not touched                                       |
| `LOOP_NODE_AI_FIELDS` / `LOOP_GROUP_NODE_AI_FIELDS`              | `context` field             | **unaffected** | Confirmed `context` is intentionally ignored (with a load-time warning) on loop/loop_group nodes — out of scope |

## Label Snapshot

- Risk: `risk: low`
- Size: `size: XS`
- Scope: `workflows`
- Module: `workflows:dag-executor`

## Change Metadata

- Change type: `fix`
- Primary scope: `workflows`

## Linked Issue

- Closes: **none filed on GitHub yet** — this PR's spec lives in
  `.docs/parallel-shared-context-session.issue.md` /
  `.docs/parallel-shared-context-session.prd.md` in this same branch. File a GitHub issue
  from that doc before/when opening the PR if the project wants a tracked number to close
  against.
- Related: #1992 (cross-provider session-boundary guard — read, not modified, by this fix)
- Depends on: none
- Supersedes: none

## Validation Evidence (required)

```bash
bun run type-check --filter @archon/workflows   # PASS (workflows package clean; unrelated
                                                 #   pre-existing --filter flag error on the
                                                 #   trailing root tsc invocation in the
                                                 #   script itself, not caused by this change)
bun test src/dag-executor.test.ts               # PASS — 451 pass, 0 fail, 1098 expect() calls
                                                 #   (450 pre-existing + 1 new regression test)
```

Additionally verified the new test is a genuine regression check, not a tautology: with the
`dag-executor.ts` fix reverted via `git stash` (test file kept), the new test fails with
`Expected: "sess-a", Received: undefined` — confirming it fails against the pre-fix code and
passes only with the fix applied. Full source diff restored via `git stash pop` afterward;
confirmed both files show as modified again.

- Evidence provided: command output captured during this session (type-check, targeted test
  run, and the stash/pop before/after comparison).
- Intentionally skipped: full `bun run validate` / full-repo `bun run test` — the change is
  isolated to one function in `@archon/workflows`, and the package-level suite plus
  type-check give complete coverage of the affected code path; no other package imports the
  modified (module-private) `runLayers` function directly.

## Security Impact (required)

- New permissions/capabilities? `No`
- New external network calls? `No`
- Secrets/tokens handling changed? `No`
- File system access scope changed? `No`
- If any `Yes`: n/a. This only changes which prior AI session id (if any) a node resumes;
  the existing cross-provider guard (#1992) is untouched and still prevents a session id
  from threading into a node that resolves to a different provider than the one that
  created it.

## Compatibility / Migration

- Backward compatible? `Yes` — `context: 'shared'` was previously inert inside a parallel
  layer (indistinguishable from unset), so no workflow could have depended on the old
  (broken) behavior. Sequential-layer behavior is untouched.
- Config/env changes? `No`
- Database migration needed? `No`
- If yes: n/a.

## Human Verification (required)

What was personally validated beyond CI:

- Verified scenarios: read every call site of `node.context` in `packages/workflows/src`
  (not just the one being fixed) to confirm this is the only silent, unwarned bypass — see
  the Investigation section of the PRD/issue docs for the full table. Confirmed the fix
  doesn't reintroduce the race the original reset guarded against (parallel siblings never
  write back to `ctx.lastSequentialSession` mid-layer — verified the `!isParallelLayer`
  guard on the completion path is unchanged).
- Edge cases checked: a parallel-layer sibling _without_ the override (must stay fresh —
  covered by the new test); the interactive-loop-group parallel-tail-gate test that
  specifically depends on the reset still happening after a parallel layer (existing test,
  still passes, confirming the reset's _timing_ change didn't remove its _effect_).
- What was **not** verified: no manual end-to-end workflow run through the CLI/web UI with a
  real provider — this is a pure in-process control-flow fix fully exercised by the mocked
  unit test; a live run would exercise the same code path with no additional risk surface.

## Side Effects / Blast Radius (required)

- Affected subsystems/workflows: only workflow runs (and `loop_group` body iterations, which
  share the same `runLayers()` function) that contain a parallel layer (2+ nodes with
  identical `depends_on`) where at least one node sets `context: 'shared'`. No effect on any
  other workflow shape.
- Potential unintended effects: none identified — the reset still happens, just after
  dispatch instead of before, and no code reads `ctx.lastSequentialSession` between "layer
  dispatch completes" and "the reset runs" other than the already-guarded write-back.
- Guardrails/monitoring for early detection: existing `dag.session_resume_failed` /
  `dag.session_provider_boundary_fresh` structured log events already fire if a resumed
  session turns out to be cold or crosses a provider boundary — unchanged, and now also
  cover the newly-functional `'shared'` parallel path.

## Rollback Plan (required)

- Fast rollback command/path: revert this PR's commit(s) on `dev` — the change is two small,
  self-contained edits in one function; no data migration to reverse, no config to unset.
- Feature flags or config toggles (if any): none — `context: 'shared'` is not gated behind a
  flag; it's an existing documented field that now behaves as documented.
- Observable failure symptoms: a parallel-layer node with `context: 'shared'` resuming a
  session unexpectedly (or a sibling without the override picking up the wrong session,
  which would indicate the reset-timing change regressed).

## Risks and Mitigations

- Risk: delaying the cursor reset to after dispatch could, in theory, let a parallel node's
  completion race the reset and leak a stale cursor into the next layer.
  - Mitigation: the existing `!isParallelLayer` guard on the per-node completion path
    already prevents any parallel-layer node from writing to `ctx.lastSequentialSession` —
    confirmed by reading that guard, not just assuming it. Every node in the layer reads the
    identical, unmodified pre-layer cursor value; the reset after `Promise.allSettled`
    still runs before the next layer starts, closing the window in exactly the same place
    control flow already serializes on.
- Risk: the fix narrowly targets `runLayers()`; a hypothetical duplicate implementation
  elsewhere (e.g. `dry-run.ts`) could still have the bug.
  - Mitigation: checked — `dry-run.ts` does not read or duplicate any session-cursor logic,
    so there is no second copy of this bug to fix.
