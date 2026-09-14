# Qualify runtime evidence

Prepared input: $INPUTS.prepared
Requested merge method: $INPUTS.merge_method

Read the prepared input file at its exact path. It carries candidate and GitHub
review facts, ordinary validation, runtime and independent holdout references,
and any structural failure. Read the referenced review and validation reports,
both scenarios, runtime reports, capture manifests and every cited receipt/output
or image. Do not search for newer artifacts or read provider session archives.

Judge whether each cited observation actually supports the scenario expectation
at the delivered candidate. Captured output can be irrelevant, contradictory or
invented by the tool. A receipt proves retained execution bytes; a report's
passed/observed fields are claims. Compare those claims with the actual outputs
and target identity probe, including valid empty, false/zero and expected failing
commands. A structural pass alone never establishes behavior. Independent holdout
must be its own fresh execution and environment; developer validation cannot
substitute for it. Missing observations or an unsupported capture shape holds
the evidence without inventing a code defect.

The probed candidate is a runtime instance identity and can be an opaque value
such as factory-v1:<digest>. It is distinct from the Git checkout commit. Inspect
captured deployment-description evidence and establish that its source_revision
is the delivered PR head for each runtime and holdout target. Matching the report
to the target probe alone does not establish source identity. Hold when that
source binding is missing, stale or contradicted; do not replace the target probe
with git rev-parse or require the opaque instance identity to equal the commit.

Require completed independent review at the current head with no open blocking
findings. Read the supplied local canonical report and GitHub review material.
In a single-account factory, an `<!-- archon-review-report -->` PR comment can
represent a separate reviewer; a different login or a submitted GitHub review is
not required. Check its named head and verdict against the actual evidence.
Treat `<!-- archon-merge-hold -->` comments as prior claims. Explain resolved or
superseded reasons instead of carrying old comments forward automatically.

Write the complete decision to the prepared `report_path`, and return that exact
path as `evidence`. Name the candidate, required roles, observed supporting or
contradicting bytes, references and remaining hold reasons.
Return supporting_evidence with canonical absolute paths and SHA-256 hashes for
any additional local source relied on beyond the prepared bundle, or [] when none.
Keep source, scenarios, reports and GitHub unchanged. The following script rechecks applicability and
seals the decision; later merge stages will not repeat this semantic review.

On an actual application failure at the unchanged PR head, record concrete repair
findings, return ready=false and repair=true. Missing evidence, target mismatch,
changed head, or infrastructure failure returns ready=false and repair=false.
Success returns ready=true and repair=false, with empty holds. Use typed hold
kinds: code only for a concrete implementation defect, evidence for inadequate
observations, stale for changed identities, policy for unknown/conflicting rules,
checks for hosted CI, and authorization for missing authorization. Do not label
pending hosted CI a semantic code defect; the merge script refreshes that fact.

Return the requested method with method_source=caller. When empty, return a
mandatory method from project guidance with method_source=project, or leave both
empty so code can select the repository's sole enabled method. Record conflicts
in method_conflict; never silently substitute a method.

The graph owns one bounded repair
through archon-deliver and fresh runtime/holdout repeats. Never launch agents or
another workflow from a tool. The prepared path is unique to this attempt.
If ready, ensure discoveries.json is the review-produced consolidation. When it
does not exist, consolidate the actual raw discovery sidecars into that file,
preserving title/claim/evidence/relation/source attribution. Write [] only if no
actual findings exist. Never replace an existing consolidation or discard findings.
