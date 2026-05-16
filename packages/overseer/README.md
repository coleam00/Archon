# @archon/overseer

**Status:** Skeleton (v0.1.0, 2026-05-16)
**Design authority:** [BDC_XO/docs/superpowers/specs/2026-05-09-WO-HARNESS-OVERLORD-ROUTING-INTEGRATION-01.md](https://github.com/bluedevilcollectibles/bdc-xo)
**Python prior art:** `overlord/overlord/router.py` at https://github.com/bluedevilcollectibles/overlord

## What this is

The Cauldron workflow-failure decision layer. Given a failed node + error context, decides whether to retry, skip, commit-anyway, or escalate.

Replaces the pattern of bolting smart-failure-handling into each persona prompt with a single control-plane module that every node consults on failure.

## What this is NOT (yet)

- **No LLM proxy** — Cauldron still calls Anthropic SDK directly. Provider failover deferred to Overseer v2.
- **No grader integration** — bdc-wo-grader workflow is its own thing.
- **No persistence** — decisions are not logged to `bdc_harness_events` yet. Add when v2 ships.
- **No HTTP server** — pure in-process TypeScript, no sidecar.

## API

```typescript
import { classifyError, decide } from "@archon/overseer";

// 1. Classify the failure
const errorClass = classifyError({
  message: "bash: line 3: npm: command not found",
  nodeId: "verify-build",
  exitCode: 127,
});
// → "npm_not_found"

// 2. Decide what to do
const result = decide({
  errorClass,
  attempt: 1,
  hasOutput: false,
  nodeId: "verify-build",
});
// → { decision: "skip", reason: "node uses npm/npx/pnpm/yarn but container is bun-only..." }
```

## Recognized error classes

| Class | Source |
|---|---|
| `rate_limit_exceeded` | Provider 429 OR message |
| `out_of_credits` | Provider message |
| `service_unavailable` | 5xx OR provider message |
| `auth_failed` | 401/403, `invalid_grant`, `refresh_expired` |
| `invalid_request` | 400 |
| `sentinel_mismatch` | Loop node + "SDK returned success" |
| `npm_not_found` | "command not found: npm/npx/pnpm/yarn" |
| `worktree_collision` | git: "is already used by worktree" |
| `branch_ref_missing` | git: "couldn't find remote ref" |
| `spec_lookup_failed` | read-spec node + "Spec not found" |
| `verify_pre_existing` | verify-* node + non-zero exit |
| `unknown` | Fallback — escalates by default |

## Decisions

| Decision | When | What |
|---|---|---|
| `retry` | Transient errors, attempt < N | Re-run the node after `backoffMs` |
| `skip` | Recoverable failure unrelated to WO scope (npm_not_found, verify_pre_existing) | Continue workflow, mark node as warning |
| `commit_and_push_anyway` | Implementation work is good despite node-level failure (sentinel_mismatch + hasOutput) | Proceed to PR-open with note in body |
| `escalate` | Unknown classes, persisted retriable, or true blockers | Abort + log diagnostic (preserve current behavior) |

## Integration (proposed wiring into `dag-executor.ts`)

Not yet wired. Reference shape for the builder of Overseer v1.5:

```typescript
import { classifyError, decide } from "@archon/overseer";

// In dag-executor's node-failure handler:
async function handleNodeFailure(node, error, attempt) {
  const errorClass = classifyError({
    statusCode: error.statusCode,
    message: error.message || error.stderr,
    nodeId: node.id,
    nodeType: node.type,
    exitCode: error.exitCode,
  });

  const result = decide({
    errorClass,
    attempt,
    hasOutput: Boolean(node.lastOutput?.length),
    nodeId: node.id,
  });

  // Log for observability (Mission Control "Workflow Decisions" tab will read this)
  logger.info({
    module: "overseer",
    runId, nodeId: node.id, errorClass, decision: result.decision, reason: result.reason,
  }, "overseer.decision");

  switch (result.decision) {
    case "retry":
      await sleep(result.backoffMs ?? 0);
      return { action: "retry" };
    case "skip":
      return { action: "continue_with_warning" };
    case "commit_and_push_anyway":
      // Workflow should proceed to commit-and-push + open-pr nodes
      // with a note in the PR body about the bypassed failure
      return { action: "continue_with_pr_note", noteContext: result.reason };
    case "escalate":
      return { action: "abort" };
  }
}
```

## Testing

```bash
cd packages/overseer
bun test
```

25 tests cover all error classes + decisions. New rules require new tests (fail-closed pattern).

## Roadmap to v2 (post-Mutant Market install June 15)

- Wire into `dag-executor.ts` per integration shape above
- Add `bdc_harness_events` Supabase logging (table already exists, see `overlord/migrations/`)
- Add Mission Control "Workflow Decisions" dashboard tab
- LLM proxy with provider failover (Anthropic ↔ OpenAI via `routing.yaml` config)
- Grader integration for WO completion verdicts
- Per-WO-class override rules (e.g. engine WOs require stricter retries)

## Why a new TS package vs the existing Python overlord

The existing `overlord/` Python package (router.py, grader/, dispatcher.py) was built 2026-05-09 for a BDC-native harness that never shipped. When BDC adopted Archon (forked as bdc-harness), the Python Overlord became orphaned — it has no integration path into Cauldron's bun-only runtime.

This TS package implements the load-bearing slice (error classification + decisions) in the same runtime, avoiding cross-language friction. The Python Overlord's design authority survives; the implementation is fresh.

Per John 2026-05-16: "we didn't have a harness" — the original Overlord was waiting for its time. This package is that time, scoped down to the minimum that prevents today's failure modes.
