# Qualify runtime evidence

Candidate: $INPUTS.candidate
Runtime: $INPUTS.runtime
Independent holdout: $INPUTS.holdout
Read the referenced reports, assertions and target identity evidence in full.
Require both actual verified=true results, independent fresh environments, and
proof that each target ran the delivered candidate revision. Re-read git HEAD and
the PR head with gh; both must still equal the candidate. Missing, inconclusive,
stale or mismatched evidence holds merging. Write runtime-qualification.md under
$ARTIFACTS_DIR with the PR, revision, result and report paths; return that path
as evidence. Do not alter scenarios, reports or source code to make them pass.

On an actual application failure at the unchanged PR head, record concrete repair
findings, return ready=false and repair=true. Missing evidence, target mismatch,
changed head, or infrastructure failure returns ready=false and repair=false.
Success returns ready=true and repair=false. The graph owns one bounded repair
through archon-deliver and fresh runtime/holdout repeats. Never launch agents or
another workflow from a tool. Use a unique qualification report path each time
so the first failure evidence survives a retry.
If ready, ensure discoveries.json is the review-produced consolidation. When it
does not exist, consolidate the actual raw discovery sidecars into that file,
preserving title/claim/evidence/relation/source attribution. Write [] only if no
actual findings exist. Never replace an existing consolidation or discard findings.
