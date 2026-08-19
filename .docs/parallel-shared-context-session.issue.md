---
name: Bug Report
about: A workflow-authored behavior silently does nothing
title: "context: 'shared' has no effect on a parallel-layer node — the session cursor is wiped before the node ever reads it"
labels: bug
---

## Problem

- **What problem are you trying to solve?**

  `context: 'shared'` is a documented, schema-valid value
  (`packages/docs-web/src/content/docs/guides/authoring-workflows.md`: _"`shared` = inherit
  from prior node. Defaults to `fresh` for parallel layers, inherited for sequential"_). Its
  entire reason to exist is to let a workflow author **override** the parallel-layer default
  and force one specific sibling to resume the previous node's AI session.

  In `packages/workflows/src/dag-executor.ts`'s `runLayers()`, that override was silently a
  no-op. Two independent things conspired to swallow it:
  1. At the top of every layer:
     ```ts
     if (isParallelLayer) {
       ctx.lastSequentialSession = undefined; // reset — parallel nodes can't share sessions
     }
     ```
     This ran **before** any node in the layer was dispatched, so the cursor a `'shared'`
     node would need to read was already gone by the time its own code ran.
  2. The freshness decision never checked for `'shared'` in the first place:
     ```ts
     const isFreshSequential = isParallelLayer || node.context === 'fresh';
     ```
     `isParallelLayer` alone forced `isFreshSequential = true` for every node in the layer,
     with no exception carved out for `node.context === 'shared'`.

  Net effect: a `prompt:`/`command:` node in a parallel layer that declared
  `context: 'shared'` behaved **identically** to one that declared nothing, or even
  `context: 'fresh'` — always a brand-new session, never a resume. The setting parsed,
  validated, and silently did nothing at runtime. No warning, no error — it just didn't work.

- **Who experiences it?**

  Any workflow author who puts sibling nodes in a parallel layer (two nodes with the same
  `depends_on` set) and wants one of them to continue the conversation from the node that
  fed the layer, instead of starting cold. This is exactly the scenario `'shared'` exists
  for — the sequential default already does this for free, so the only place `'shared'` is
  ever meaningfully _set_ is inside a parallel layer.

- **How often does it come up?**

  Every workflow that uses `context: 'shared'` inside a parallel layer hits this — there is
  no partial/degraded case, it never worked.

## Where else `context` is read (audited, not bypassed)

Per request, I checked every other place `node.context` is consulted in
`packages/workflows/src` to confirm this is the only silent bypass:

| Location                                                                    | What it checks                                                            | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dag-executor.ts` `isPersistableNode()` (`context === 'fresh'`)             | Whether a node opts out of **cross-run** `persist_session` DB persistence | Correct — `'shared'` has no meaning here; persistence is a separate opt-in (`persist_session`) from in-run sequential threading. Unaffected by this bug.                                                                                                                                                                                                                                                                                      |
| `loader.ts:701` (`context === 'fresh'`)                                     | Same cross-run persistence, but at load-time capability validation        | Same as above — correct, unrelated to the bug.                                                                                                                                                                                                                                                                                                                                                                                                |
| `LOOP_NODE_AI_FIELDS` / `LOOP_GROUP_NODE_AI_FIELDS` (`schemas/dag-node.ts`) | AI-only fields that are _unsupported_ on `loop:`/`loop_group:` nodes      | `context` is deliberately included in both lists. Setting it on a `loop:`/`loop_group:` node produces a `loop_node_ai_fields_ignored` / `loop_group_node_ai_fields_ignored` **warning at load time** (`loader.ts` `parseDagNode`) — loops manage their own iteration-to-iteration session threading via `fresh_context`/`group.fresh_context` instead. This is an intentional, _warned_ bypass, not a silent one — out of scope for this fix. |
| `dry-run.ts`                                                                | N/A                                                                       | Does not duplicate any session-threading logic — no separate copy of this bug.                                                                                                                                                                                                                                                                                                                                                                |

So the fix below is narrowly scoped to the one unwarned bypass: `prompt:`/`command:` nodes
in a parallel layer.

## Proposed Solution

In `runLayers()`:

1. Move the parallel-layer cursor reset from _before_ the layer's `Promise.allSettled`
   dispatch to _after_ it. Nodes can now read `ctx.lastSequentialSession` as it stood at the
   end of the previous layer; the reset still runs before the _next_ layer starts, so a
   parallel layer still can't hand a single cursor forward (siblings fork independently and
   never write back to it mid-layer — the existing `!isParallelLayer` guard on the
   completion path already prevents that race).
2. Change the freshness predicate to carve out the explicit override:
   ```ts
   const isFreshSequential =
     node.context === 'fresh' || (isParallelLayer && node.context !== 'shared');
   ```

No schema change, no new field, no new node type — this only fixes the executor's reading
of a value the schema and docs already promised.

## User Flow

### Before (current)

```
Layer N-1 (sequential): "a" completes → ctx.lastSequentialSession = { sess-a, claude }
Layer N (parallel): [b (context: 'shared'), c]
  ├─ ctx.lastSequentialSession reset to undefined BEFORE b/c run   [bug]
  ├─ b: isFreshSequential = true (isParallelLayer wins) → fresh session, sess-a lost
  └─ c: isFreshSequential = true → fresh session (expected)
```

### After (fixed)

```
Layer N-1 (sequential): "a" completes → ctx.lastSequentialSession = { sess-a, claude }
Layer N (parallel): [b (context: 'shared'), c]
  ├─ cursor still holds { sess-a, claude } when b/c dispatch
  ├─ b: isFreshSequential = false (context: 'shared' overrides parallel default)
  │     → resumes sess-a (same-provider guard from #1992 still applies)
  ├─ c: isFreshSequential = true (no override) → fresh session (unchanged)
  └─ AFTER dispatch: ctx.lastSequentialSession reset to undefined
        (a parallel layer still can't hand ONE cursor to the next sequential layer)
```

## Alternatives Considered

| Alternative                                                                                               | Pros                                              | Cons                                                                                                    | Why not chosen                                                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Leave the reset before dispatch, special-case `'shared'` to re-read a separately-stashed pre-layer cursor | Reset stays "at the top"                          | Adds a second piece of state to keep in sync for no benefit                                             | More moving parts than just reordering the existing reset                                          |
| Give every parallel node the pre-layer cursor by default (drop the fresh-by-default parallel behavior)    | `'shared'` becomes unnecessary                    | Changes the documented default for every existing parallel workflow — a behavior change with no opt-out | Rejected — breaks the documented contract and is a much bigger blast radius than the bug fix needs |
| Fix as scoped: keep parallel-fresh default, make `'shared'` the explicit escape hatch                     | Matches documented behavior exactly; minimal diff | None                                                                                                    | Chosen                                                                                             |

## Scope

- **Package(s) likely affected:** `workflows` (`dag-executor.ts` only)
- **Breaking change?** No — `'shared'` was never functional in a parallel layer, so no
  existing workflow could have been relying on the broken (always-fresh) behavior as a
  feature. Sequential-layer behavior (the common case) is untouched.
- **Database changes needed?** No
- **New external dependencies?** No

## Security Considerations

- **New permissions/capabilities?** No
- **New external network calls?** No
- **Secrets/tokens handling?** No — this only changes which prior AI session id (if any) a
  node resumes; the existing cross-provider guard (#1992) is untouched and still prevents a
  session id from being threaded into a node that resolves to a different provider.

## Implementation Plan

- [x] Move the parallel-layer `ctx.lastSequentialSession` reset to after layer dispatch
- [x] Add the `node.context !== 'shared'` carve-out to `isFreshSequential`
- [x] Regression test: parallel layer `[shared-sibling, plain-sibling]` after a sequential
      node — `shared-sibling` resumes, `plain-sibling` stays fresh
      (`dag-executor.test.ts`, `provider-boundary session threading (#1992)` describe block)
- [x] Confirmed the new test fails on the pre-fix code and passes after (verified via
      `git stash`)
- [x] Full `dag-executor.test.ts` suite green (451/451) and `@archon/workflows` type-check clean

## Definition of Done

- [x] A `prompt:`/`command:` node with `context: 'shared'` in a parallel layer resumes the
      prior sequential session (same-provider only, per #1992)
- [x] A sibling in the same parallel layer without the override still defaults to fresh
      (no regression to the documented default)
- [x] No change to sequential-layer behavior (already correct)
- [x] No change to the intentional, warned loop/loop_group bypass

## Related Issues

- References the cross-provider session-boundary guard (#1992) — untouched, still enforced
  on the `'shared'` resume path.

## Notes

- This was found by manual code inspection while pairing on unrelated `dag-executor.ts`
  work — not reported by a user workflow failing in the field, but the failure mode (silent
  no-op, no warning, no error) means it could easily have shipped unnoticed in any workflow
  that tried to use `context: 'shared'` inside a parallel layer.
- No test coverage existed for `context: 'shared'` at all before this fix — the gap that let
  this ship in the first place.
