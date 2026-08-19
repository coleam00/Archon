# PRD: Honor `context: 'shared'` on parallel-layer DAG nodes

**Feature Name:** Parallel-layer `context: 'shared'` session-cursor fix
**Status:** Implemented
**Target Release:** next patch
**Dependencies:** None (bug fix, no new infrastructure)

---

## Executive Summary

`context: 'shared'` is a documented DAG-node field meant to let a workflow author force one
sibling in a parallel layer to resume the AI session of the node that fed the layer,
overriding the parallel-layer default of a fresh session per sibling. In
`packages/workflows/src/dag-executor.ts`, the session cursor the executor threads between
sequential nodes (`ctx.lastSequentialSession`) was unconditionally wiped at the _start_ of
every parallel layer, before any node — including one asking for `'shared'` — could read it,
and the freshness decision never special-cased `'shared'` in the first place. The setting was
schema-valid, documented, and completely inert.

The fix reorders one reset and adds one condition inside `runLayers()`. No schema change, no
new node field, no new node type.

---

## Problem Statement

**Current state (pre-fix):**

```ts
// packages/workflows/src/dag-executor.ts, runLayers()
const isParallelLayer = layer.length > 1;

if (isParallelLayer) {
  ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
}

// ...per-node dispatch, later...
const isFreshSequential = isParallelLayer || node.context === 'fresh';
```

Two compounding defects:

1. The reset ran **before** the layer's nodes were dispatched (`Promise.allSettled`), so by
   the time any node's own logic ran, `ctx.lastSequentialSession` was already `undefined` —
   there was nothing left to inherit even for a node that wanted to.
2. `isFreshSequential` derived purely from `isParallelLayer || node.context === 'fresh'` —
   there was no branch that ever set it to `false` because of `node.context === 'shared'`.
   A `'shared'` node in a parallel layer was therefore indistinguishable, at runtime, from a
   node with no `context` set at all.

**Consequence:** any workflow relying on `context: 'shared'` inside a parallel layer got a
fresh AI session for that node every time, silently — no load-time warning (the field is
schema-valid on `prompt:`/`command:` nodes, unlike its documented ignore-list treatment on
`loop:`/`loop_group:` nodes — see Investigation below), no runtime error, just the wrong
behavior.

**Desired state:** a `prompt:`/`command:` node in a parallel layer with
`context: 'shared'` resumes the AI session left behind by the most recent sequential node
before the layer, subject to the existing same-provider guard (#1992). Siblings without the
override keep the documented fresh-by-default parallel behavior, unchanged.

---

## Investigation: is `context` bypassed anywhere else?

Audited every read of `node.context` in `packages/workflows/src` before concluding the fix
was complete:

| Site                                                                      | Purpose                                                                               | Finding                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dag-executor.ts` `isPersistableNode()`                                   | Excludes `context: 'fresh'` nodes from **cross-run** `persist_session` DB persistence | Unrelated concern (persistence, not in-run threading) — correct as-is, not a bypass of `'shared'`.                                                                                                                                                                                                                                                                                    |
| `loader.ts:701`                                                           | Same exclusion, applied at load-time capability validation                            | Same as above — correct, not a bypass.                                                                                                                                                                                                                                                                                                                                                |
| `schemas/dag-node.ts` `LOOP_NODE_AI_FIELDS` / `LOOP_GROUP_NODE_AI_FIELDS` | Lists of AI-only fields _unsupported_ on `loop:`/`loop_group:` nodes                  | `context` is included in both lists **on purpose** — loops manage their own cross-iteration session threading via `fresh_context`/`group.fresh_context`, a different mechanism. Setting `context` on a loop node produces a `*_ai_fields_ignored` **warning at load time** (`loader.ts` `parseDagNode`). This is an intentional, surfaced bypass — not the silent bug this PRD fixes. |
| `dry-run.ts`                                                              | Workflow dry-run/preview path                                                         | Does not read or duplicate `ctx.lastSequentialSession` / `node.context` logic at all — no parallel copy of the bug.                                                                                                                                                                                                                                                                   |

Conclusion: the parallel-layer path in `runLayers()` was the **only** place `'shared'` was
silently swallowed without any signal to the author. The fix is scoped to exactly that path.

---

## Goals

1. `context: 'shared'` on a `prompt:`/`command:` node in a parallel layer resumes the
   session cursor left by the prior sequential node, when one exists and the resolved
   provider matches (per the existing #1992 guard).
2. A parallel-layer sibling that does **not** set `context: 'shared'` keeps today's
   documented fresh-by-default behavior — zero change.
3. Sequential-layer behavior (`context: 'shared'`, unset, or `'fresh'`) is untouched — it
   was already correct.
4. A parallel layer still cannot hand a single cursor forward into the _next_ layer — every
   sibling forks independently, and after the layer completes the cursor resets, exactly as
   before, just one step later in the control flow.

## Non-Goals

- Not changing loop/loop_group session semantics (`fresh_context`) — those are a separate,
  intentionally-different mechanism, already load-time-validated.
- Not adding a new field, node type, or YAML surface — `context: 'shared'` already exists
  and is documented; this only makes the executor actually honor it.
- Not changing the cross-provider guard (#1992) — a `'shared'` resume into a
  different-provider node still falls back to fresh, exactly as a sequential-layer resume
  does today.

---

## Design

### The fix

```ts
// runLayers(), packages/workflows/src/dag-executor.ts

for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
  const layer = layers[layerIdx];
  const isParallelLayer = layer.length > 1;

  // (no reset here anymore — moved below, after dispatch)

  const layerResults = await Promise.allSettled(
    layer.map(async node => {
      // ...
      const isFreshSequential =
        node.context === 'fresh' || (isParallelLayer && node.context !== 'shared');
      const cursor = ctx.lastSequentialSession;
      // ...unchanged resume/provider-boundary logic below this point...
    })
  );

  // ...process layerResults (unchanged; the existing `!isParallelLayer` guard already
  // prevents a parallel node's own output from becoming the next cursor)...

  if (isParallelLayer) {
    // Reset AFTER dispatch: a parallel layer still can't hand ONE cursor to the next
    // sequential layer once it's over, but nodes inside THIS layer got their chance to
    // read the pre-layer cursor via context: 'shared' above.
    ctx.lastSequentialSession = undefined;
  }

  // ...unchanged between-layer status checks...
}
```

Why this ordering is safe: within a parallel layer, no node ever writes back to
`ctx.lastSequentialSession` — the write-back at the end of the per-node completion handling
is already gated on `!isParallelLayer`. So every node in the layer reads the _same_,
unmodified pre-layer cursor value regardless of dispatch/completion order — there's no race
introduced by delaying the reset.

### Scope of `isFreshSequential`

The predicate only needed one added clause. `'shared'` is meaningless outside a parallel
layer (sequential layers already default to inherited), so the clause is scoped to
`isParallelLayer && node.context !== 'shared'` rather than touching the sequential branch at
all.

---

## Testing Plan

### Unit Tests (implemented)

Added to `executeDagWorkflow -- provider-boundary session threading (#1992)` in
`dag-executor.test.ts` — chosen because that describe block already owns the mocked
`sendQuery` + `runWorkflow` helpers this scenario needs:

- `a` (sequential) → parallel layer `[shared (context: 'shared'), plain]`, both depending on
  `a`.
- Asserts (by prompt text, not call index, since parallel dispatch order isn't guaranteed):
  - `a` runs with `resumeSessionId === undefined` (nothing before it).
  - `shared` runs with `resumeSessionId === 'sess-a'` (the override worked).
  - `plain` runs with `resumeSessionId === undefined` (default preserved).

Verified this test fails on the pre-fix code (`git stash` the source fix, rerun — fails with
`Expected: "sess-a", Received: undefined`) and passes with the fix restored.

### Regression

Full `dag-executor.test.ts` suite: 451/451 pass (450 pre-existing + 1 new). This suite
already covers the adjacent, previously-correct behaviors that had to remain correct:
same/different-provider sequential threading, loop/loop_group provider-boundary threading,
and the interactive-loop-group parallel-tail-gate null-session-pause test — which depends on
the reset still happening (just later) — all still pass.

### Manual Tests

Not performed — the unit test above exercises the exact code path
(`runLayers`/`Promise.allSettled` dispatch + mocked `sendQuery`) that a real workflow run
would hit; no adapter- or platform-specific behavior is involved.

---

## Backward Compatibility

- ✅ No schema change — `context: 'shared'` already existed and validated.
- ✅ No behavior change for any node that doesn't set `context: 'shared'` inside a parallel
  layer — sequential layers, `'fresh'`, and unset `context` are all untouched.
- ✅ Cannot have been relied upon in its broken form — the prior behavior (always fresh) was
  indistinguishable from simply not setting `context` at all, so no workflow could depend on
  the old bypass as a feature.
- ✅ No DB schema changes, no config changes.

---

## Open Questions

None — this is a scoped bug fix with an already-implemented, tested resolution.
