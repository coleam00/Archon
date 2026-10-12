# Error Review — Failure Visibility and Containment

Find either defect: **a real failure crosses the changed code and becomes indistinguishable from success to the caller, operator, or user who must react; or it escapes its owning item and aborts independent work**. Not every error needs logging; recovery is correct when the contract permits it and the right owner can still observe the outcome. Read-only: never modify files, commit, or post anywhere. Never edit this checkout, not even to revert: sibling reviewers read it at the same time, and the engine fails a reviewer that leaves it changed. Try a mutation in a scratch worktree (`git worktree add --detach "$(mktemp -d)" HEAD`, removed when you are done), and before running anything there, install its dependencies with the project's own package manager in locked mode, never updating a lockfile.

Read `$ARTIFACTS_DIR/review/scope.md` first, and, where the project has them, its `architecture.md`, its `engineering.md`, and its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point. Those are the project's own values: a preference one of them states is a finding you cite, and one none of them states is taste you leave out. Anchor the review on the accepted work order's stated invariants, and apply the supplied full-review policy: **$mode.output.risks**. In light mode, verify prior findings from this lens first, then examine only the delta.

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

Where this defect concentrates: background work, callbacks, and cancellation; retry exhaustion; partial multi-step operations; and error translation across process, API, UI, or persistence boundaries.

## Legitimate silence — do not report

An explicitly best-effort operation; a capability probe whose failure is the expected negative; an internal retry whose final outcome preserves the contract; a bounded, behaviorally-equivalent compatibility fallback; duplicate logging when a higher boundary already records with better context; a library propagating a required dependency failure to its owner; cancellation staying cancellation.

## What a finding costs

State what each finding costs if it merges — the concrete consequence and who meets it — and never assign it a severity: synthesis labels every finding. Name what the false success, lost failure, or aborted independent work lets happen next — lost data, an irreversible action, an outage nobody sees, a caller that cannot recover. No cosmetic message-wording suggestions.

When a clearance describes a predicate or contract, quote the actual code or config with its source, never your own characterization. If you cannot quote it, mark it unverified and leave it off the clean list.

## Output

Write `$ARTIFACTS_DIR/review/errors.md`: each in-scope finding begins with `sources: [errors]`, followed by the evidence parts for its failure mode and the smallest correction (propagate, preserve identity, mark degraded, or report at the owning boundary), then the examined-and-visible-and-contained list citing the contracts that handle failure correctly. In light mode, a verdict per prior finding. No findings is a valid result.

A defect that touches the change — on the path it changed, made reachable or visible by it, or a claim it makes false — is a finding, even when the contract never named it. A proved defect you meet that does not touch the change — unrelated or pre-existing — is a discovery, never silence: reporting it now costs less than rediscovering it later. Write `$ARTIFACTS_DIR/discoveries/review-errors.json` as a JSON array of records with `title`, `claim`, `evidence` (concrete `file:line` facts or command results), `relation` (`unrelated`, or `scope_conflict` when the requested outcome itself would need an explicit boundary crossed), and `source_node` (`errors`). Write no file for no discovery; never append to another lens's file or record suspicion.

Verify every cited `file:line` is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/errors.md` and the findings count.
