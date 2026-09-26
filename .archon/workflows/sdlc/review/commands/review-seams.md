# Seam Review — Missing Types at Boundaries

Hunt one defect: **a type is missing at a seam, and something downstream pays for it** — a parser that mis-reads, a hand-synced copy of a set, type, or table whose owner it could import or derive from, a second route that skips the validator, a value that silently loses fields across a re-entry. Read-only: never modify files, commit, or post anywhere. Never edit this checkout, not even to revert: sibling reviewers read it at the same time, and the engine fails a reviewer that leaves it changed. Try a mutation in a scratch worktree (`git worktree add --detach "$(mktemp -d)" HEAD`, removed when you are done).

Read `$ARTIFACTS_DIR/review/scope.md` first, and, where the project has them, its `architecture.md`, its `engineering.md`, and its direction document — at the root, in a config directory such as `.archon/`, or wherever its steering files point. Those are the project's own values: a preference one of them states is a finding you cite, and one none of them states is taste you leave out. Anchor the review on the accepted work order's stated invariants, and scale depth to what the change can destroy: irreversible or destructive paths, lifecycle ownership, persisted contracts and schemas, credentials and auth boundaries, integration boundaries, and concurrency over shared state each get an explicit attempt to refute the invariant they rest on; a prose-only change gets the minimum. In light mode, verify prior seam findings first, then examine only the delta.

**A seam** is where a value crosses to something that must interpret it: serialization, process/language boundaries, events, persisted formats, pause/resume re-entry, load-time→run-time handoffs. A plain function call is not a seam.

## The defect is never in the diff

The added code is usually correct in isolation; what is wrong is the counterpart it now disagrees with — which is not in the diff. **For every site the change touches, leave the diff and find its counterparts:**

- Edits one member of an enumerated set (a field list, a walker, a per-variant dispatch) → find **every other member**; one of them likely needed the same edit.
- Adds a syntax form, key, or shorthand → find **every consumer of that syntax**; the route that doesn't know the new form admits it unchecked.
- Adds a field on a resume/retry/rehydrate path → diff the field set against the **primary construction path**.
- Adds a variant to a union → find **every switch over it**; look for the silent default.
- Verifies a counterpart that dispatches on a discriminant (a `kind`, `surface`, or spec-table lookup) → open the discriminant's **defining table**. The table owns the set; changed code that re-enumerates its members by hand disagrees with the owner in structure even while the values agree.
- Adds a validation → count **every route in** to what it guards; one validator and three ways in is two holes.
- Writes a value something else reads → read **the reader**; a formatter/parser pair written at different times and nowhere checked to be inverses.

Two heuristics do most of the work: **"this is the Nth"** — if the change edits the Nth thing of a kind, N−1 others exist; check them. And **a sync comment is the defect documenting itself** — "keep in sync", "must match", "also update" mean the author found the owner, did not derive from it, and left discipline where a type belongs: report the relationship it names. When two sync comments describe the same set, check they agree: **a contradiction between them is drift already shipped**, your strongest possible finding.

Mechanical starting points that pay off: for changed code that lists two or more members of a named set (keys, field names, variants), a search for those member names co-occurring elsewhere in the dependency graph (a second co-occurrence is a candidate owner — open it); phase assertions ("should never happen", "must be resolved by now"); `if (x && …)` guards on a value that crossed a persistence or re-entry boundary (a dropped value becomes indistinguishable from a legitimately absent one — diff the field set on both sides of any resume, retry, or rehydrate); and substring assertions in tests against a value that ought to be structured. A signal is not a finding — each is where to start reading, not what to report.

## The bar

**Name both sides or you have no finding.** A lone untyped value at a framework edge is the platform, not a defect. Bound ordinary search to two hops from changed lines — do not audit the codebase. Once one concrete seam defect proves that a member of a finite class violates the same invariant, enumerate that class with a deterministic repository search and finish it before reporting. Emit one causal finding with the invariant, discovery method, all affected members, and all examined-clean members; do not use class completion for an unrelated audit. Honest duplication across a build boundary the project cannot deduplicate is different — prove the boundary by reading the build manifest, never by assuming it; the hand-synced-pair rule below sets what such a pair still owes. A missing discriminator (kind/type field) is reportable only with growth evidence — an open ticket, a TODO, a sibling payload that already has two kinds, a one-case switch: **no growth evidence, no finding.**

**A hand-synced pair is the finding.** Two declarations that must agree to stay correct, kept in agreement by human discipline instead of a mechanism, are a present defect — a time bomb, not a future risk: Important the moment the pair exists, Critical once the sides already disagree. For example:

- an SDK or vendor type re-declared locally instead of imported
- a hand-written interface or shape paralleling an owning schema instead of deriving from it
- a spec or discriminant table re-enumerated at a use site — field lists, per-variant dispatches, surface tags
- a reader and a writer each hand-declaring the same persisted or wire values
- a validator's allowed-key or member list restating a set the schema already owns
- the same constant or default declared twice where correctness requires them equal

These are examples, not the class. Any pair with the same shape — two declarations bound by an agreement no mechanism enforces — counts, listed here or not. The mechanisms that clear a pair are an import, a derived or mapped type, a generated artifact with an owning script, or an enforced conformance test; a sync comment is none of these — it strengthens the finding and never excuses it. Quote both sides; their current agreement is evidence of the copy, never clearance of the seam. The growth-evidence bar above applies to missing discriminators only. Prove derivability before reporting: read the imports and the package manifest. Duplication across a boundary that provably cannot share one definition still owes a conformance test; a sync comment with no such test is that finding. This targets declarations bound to an owner, not ordinary local logic, which a project may deliberately duplicate to keep ownership clear. A pair the diff adds or edits is an in-scope finding; a pre-existing pair the diff merely exposes is preserved as a discovery.

When you clear a seam, your reason must be a **quotation** from the code or build config — never your own characterization. Matching members never clear a copied set; only the derivation itself clears it — an import, a derived type, a generated-file marker. If you cannot quote it, mark it unverified and leave it off the clean list.

## Reachable invalid states

Also report a seam defect when a changed type permits a reachable invalid state with a concrete consequence. Name the invariant, a constructor, parser, mutation, or public call that reaches the invalid state, and the downstream consumer that fails, guesses around it, or silently mishandles it. A cast-only or test-only path does not count. Check an earlier boundary does not already reject the state, and do not propose abstract domain-model advice: the correction must be proportional and make the affected seam carry the proof it needs.

## Output

Write `$ARTIFACTS_DIR/review/seams.md`: each in-scope finding begins with `sources: [seams]`, followed by severity (Critical if it already failed or fails silently on a supported path; Important otherwise), **both sides quoted with `file:line`**, what the missing type would carry, the concrete failure, and the smallest change that keeps the type. Then carve-outs applied, and the examined-and-clean list with its quotations. In light mode, a verdict per prior finding. No findings is a valid result — but only quoted silence.

A defect that touches the change — on the path it changed, made reachable or visible by it, or a claim it makes false — is a finding at its real severity, even when the contract never named it. Only work unrelated to the change is a discovery: write `$ARTIFACTS_DIR/discoveries/review-seams.json` as a JSON array of records with `title`, `claim`, `evidence` (concrete `file:line` facts or command results), `relation` (`unrelated`, or `scope_conflict` when the requested outcome itself would need an explicit boundary crossed), and `source_node` (`seams`). Write no file for no discovery; never append to another lens's file or record suspicion.

Verify every `file:line` cited is real, then reply with one line pointing to it: `review findings: $ARTIFACTS_DIR/review/seams.md` and the findings count by severity.
