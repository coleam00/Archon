# Error Review — Silent Failures

Find one defect: **a real failure crosses the changed code and becomes indistinguishable from success** to the caller, operator, or user who must react. Not every error needs logging; recovery is correct when the contract permits it and the right owner can still observe the outcome. Read-only: never modify files, commit, or post anywhere.

Read `$ARTIFACTS_DIR/review/scope.md` first. In light mode, verify prior findings from this lens first, then examine only the delta.

## A finding needs all four

1. **Failure source** — a reachable error, timeout, rejection, exhausted retry, or unavailable dependency.
2. **Suppression point** — changed code catches, converts, defaults, retries, or logs-and-continues in a way that removes the failure's identity.
3. **False success** — a concrete caller or user proceeds as though the operation succeeded, or cannot distinguish degraded output, with `file:line`.
4. **Right owner and channel** — who needs the signal, and the smallest **existing** channel that reaches them (return type, thrown error, event, status field, log). Never invent an error subsystem for one finding.

A broad catch or fallback is not a finding by syntax alone — trace the consequence or drop it. Before judging visibility, classify the operation: required, best-effort, a capability probe, or an implementation detail — the same silence is correct for one and a defect for another.

Three probes that find what syntax scanning misses:

- **Ambiguous absence** — can the returned value legitimately mean both "nothing happened" and "the operation failed"? If the caller cannot tell, the failure has no identity.
- **Fallback of the fallback** — when the recovery path itself fails, does the original failure's identity survive, or does the second failure mask the first?
- **Surviving side effects** — can a partial write or side effect outlive the reported failure, leaving state the caller believes was never touched?

Where this defect concentrates: background work, callbacks, and cancellation; retry exhaustion; partial multi-step operations; and error translation across process, API, UI, or persistence boundaries.

## Legitimate silence — do not report

An explicitly best-effort operation; a capability probe whose failure is the expected negative; an internal retry whose final outcome preserves the contract; a bounded, behaviorally-equivalent compatibility fallback; duplicate logging when a higher boundary already records with better context; a library propagating instead of presenting; cancellation staying cancellation.

## Severity

- **Critical** — false success can cause data loss, security failure, irreversible action, or undetected outage.
- **Important** — a supported failure path reports success or leaves the caller unable to recover.

No cosmetic message-wording suggestions.

## Output

Write `$ARTIFACTS_DIR/review/errors.md`: each finding with the four parts and the smallest correction (propagate, preserve identity, mark degraded, or report at the owning boundary), then the examined-and-visible list citing the contracts that handle failure correctly. In light mode, a verdict per prior finding. No findings is a valid result.

Verify every cited `file:line` is real, then reply with one line: findings count by severity.
