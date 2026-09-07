# Delivery handoff

`archon-ship` keeps triage, investigation/planning, implementation, review,
correction, validation and CI convergence in one invocation. `archon-deliver`
starts at implementation. Independent acceptance and merging remain outside both.

Both accept an optional `publication_policy`, forwarded to `archon-pr` for the
initial push and every review or late-CI correction. See the PR package's policy
contract. Implementation nodes commit their changes; deterministic publication
owns pushes. The normal green gate's inherited/environment red handling, review
round limits, CI waits, and ready flip remain in place.

The result is an object with:

- `outcome`: `delivered`, `no_action`, or `blocked`.
- `summary`: readable result, including discovery relay and accepted-red caveats.
- `pr`: the verified PR identity, or null when nothing was delivered. Identity
  includes number, URL, head/base branches, head/base SHAs, repository and draft state.
- `reports`: artifact paths for the implementation, review, identity and applicable
  advisory/discovery evidence. A blocked run can point to a report not yet produced.

Delivery returns only after the ready flip and a fresh identity readback. A PR
creation record alone never establishes delivery. Ship's no-work route returns
`no_action`; an unresolved plan or investigation returns `blocked`. A delivery
that stops before readback can report `blocked`. Failed producers remain engine
failures: the engine deliberately rejects bindings to their output, so an
execution failure is not guaranteed to carry an authored result. Inspect the run
failure and its artifact store in that case. These workflows do not infer or
rewrite engine lifecycle state.

The structured result is persisted as `deliver-result.json`, `ship-result.json`,
or `upkeep-result.json` under the run artifacts. This replaces the former URL
string return. All bundled consumers, including upkeep, use the object. External
callers must read `pr.url` rather than parsing the summary.

The deliver package owns the formatter. Ship and upkeep name its bundled script
through the engine's qualified resource reference, avoiding standalone copies.
Project variants that replace this formatter should update those script references
too. Schema conformance and composition tests enforce the shared output shape.
