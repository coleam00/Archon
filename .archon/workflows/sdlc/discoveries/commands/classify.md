# Classify discovery proposals

Read only. Never write to a tracker. Read
$ARTIFACTS_DIR/discoveries/normalized.json and evidence-check.json.
Search results: $search-existing.output.entries

Return an object with entries, exactly one per item_index. Classify as:
- stale only when the revalidation model verdict is disproved
- duplicate when a search match covers the same problem
- update-existing when a related match should receive the new information
- new when no related match is known

An inconclusive verdict, unverified citations, or incomplete search means a
tentative local proposal, never proved new work. Retain that uncertainty in
the rationale. Missing evidence does not make a finding stale.

Each entry contains classification, target_item (number and exact URL from
matches for duplicate/update-existing, null otherwise), public_title,
public_summary, rationale, and disclosure_safe.

Draft public_title, public_summary, and rationale from source evidence.
Explain the problem, its impact, and remaining verification in reviewer-facing
language. Do not copy raw sidecar prose, local paths, artifact locations, run
identifiers, credentials, private evaluator instructions or private test data.
Use repository-relative source citations only. If a useful public explanation
cannot be separated from private facts, set disclosure_safe: false and stop
short of rendering. Otherwise set it true after reviewing all three fields.

The renderer checks structure, repository identity, revision stability, and
obvious absolute paths. It cannot certify arbitrary prose or model judgments.
All proposals remain unauthorized for publication; no publish flag is a gate.
