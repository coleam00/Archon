# Error Review — Failure Visibility and Containment

Find either defect: **a real failure crosses the changed code and becomes indistinguishable from success to the caller, operator, or user who must react; or it escapes its owning item and aborts independent work**. Not every error needs logging; recovery is correct when the contract permits it and the right owner can still observe the outcome. Before you start, read `review-lens.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`): it says how a lens stays read-only, where scratch work goes, what counts as a finding, and how a discovery is recorded. Your scratch worktree is `git worktree add --detach "$(mkdir -p "$ARTIFACTS_DIR/.archon/scratch/errors" && mktemp -d "$ARTIFACTS_DIR/.archon/scratch/errors/XXXXXX")" HEAD`, and your scratch files go under `$ARTIFACTS_DIR`.

Read `$ARTIFACTS_DIR/review/scope.md` first. The project's own values are in its steering documents: open, where the project has one, its `engineering.md` — at the root, in a config directory such as `.archon/`, or wherever its steering files point — only when a finding depends on a value it states, and read the section you cite, not the whole file. A preference it states is a finding you cite, and one it does not state is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. On a continuation, scope.md names the prior report and the correction delta, and you examine only the delta. Read the prior report so you do not raise a finding again. When it holds a blocking finding still open whose `sources` include `errors`, you run to verify it: read `$ARTIFACTS_DIR/implementation.md`, judge each such finding as resolved by the delta, validly declined (the implementer's evidence holds), or still open, and check whether the fix introduced a new defect or side effect in this lens's area. Otherwise you run because the delta reaches new ground in this lens's area.

## Evidence bar

A suppression finding needs all four

1. **Failure source** — a reachable error, timeout, rejection, exhausted retry, or unavailable dependency.
2. **Suppression point** — changed code catches, converts, defaults, retries, or logs-and-continues in a way that removes the failure's identity.
3. **False success** — a concrete caller or user proceeds as though the operation succeeded, or cannot distinguish degraded output, with `file:line`.
4. **Right owner and channel** — who needs the signal, and the smallest **existing** channel that reaches them (return type, thrown error, event, status field, log). Never invent an error subsystem for one finding.

A containment finding needs a reachable failure source, the escaping boundary, the independent work it prevents, and the existing containment channel or owning contract. Identifiability does not clear excess blast radius. Trace dependencies before reporting: legitimate propagation of required dependency failure, cancellation, and contract-permitted best effort are not defects.

A broad catch or fallback is not a finding by syntax alone — trace the consequence or drop it. Before judging visibility, classify the operation: required, best-effort, a capability probe, or an implementation detail — the same silence is correct for one and a defect for another.

Probes that find what syntax scanning misses:

- **Blast radius** — does a failure owned by one item (another project, one case, one iteration) abort work that does not depend on it? 'Identifiable' does not clear it.
- **Ambiguous absence** — can the returned value legitimately mean both "nothing happened" and "the operation failed"? If the caller cannot tell, the failure has no identity.
- **Fallback of the fallback** — when the recovery path itself fails, does the original failure's identity survive, or does the second failure mask the first?
- **Surviving side effects** — can a partial write or side effect outlive the reported failure, leaving state the caller believes was never touched?
- **Wording-gated behavior** — does changed code decide retry, fallback, suppression, or classification by pattern-matching message text it does not own — vendor errors, log lines, human prose? The unmatched rewording is the failure source and the fallthrough branch is the suppression point: name what runs when the wording changes and who cannot tell. Matching a machine token the emitter treats as an identifier (an errno, an error code), with an honest failure on no-match, is legitimate.
- **Secrets in error text** — for every error the change surfaces, read where its message is built, in the callee too and in unchanged code, and check it against any no-secret invariant: a raw parser or command error can quote a key, a token, or a URL with credentials in it.
- **Before the `try`** — for a claim that a function never throws or reports every failure, cite each statement before its `try` and outside it; one that can throw there breaks the claim.
- **Failure result contract** — a failure path returns the result its callers read on success, with the same fields, accumulated values and status, or a typed failure they handle. A failure that drops fields or returns a bare default lets the caller read nothing as success.

Where this defect concentrates: background work, callbacks, and cancellation; retry exhaustion; partial multi-step operations; and error translation across process, API, UI, or persistence boundaries.

## Legitimate silence — do not report

An explicitly best-effort operation; a capability probe whose failure is the expected negative; an internal retry whose final outcome preserves the contract; a bounded, behaviorally-equivalent compatibility fallback; duplicate logging when a higher boundary already records with better context; a library propagating a required dependency failure to its owner; cancellation staying cancellation.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it — and never assign it a severity: synthesis labels every finding. Name what the false success, lost failure, or aborted independent work lets happen next — lost data, an irreversible action, an outage nobody sees, a caller that cannot recover. No cosmetic message-wording suggestions.

When a clearance describes a predicate or contract, quote the actual code or config with its source, never your own characterization. If you cannot quote it, mark it unverified and leave it off the clean list.

## Output

Write `$ARTIFACTS_DIR/review/errors.md`: each in-scope finding begins with `sources: [errors]`, followed by the evidence parts for its failure mode and the smallest correction (propagate, preserve identity, mark degraded, or report at the owning boundary), then the examined-and-visible-and-contained list citing the contracts that handle failure correctly. On a continuation, a verdict per prior `errors` finding you verified: still open, fixed at `<sha>`, or validly declined, with evidence. No findings is a valid result.

Your discoveries file is `$ARTIFACTS_DIR/discoveries/review-errors.json`, and your `source_node` is `errors`.

Verify every cited `file:line` is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/errors.md` and the findings count.
