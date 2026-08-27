# Seam Review — Missing Types at Boundaries

Hunt one defect: **a type is missing at a seam, and something downstream pays for it** — a parser that mis-reads, a hand-maintained list that drifts, a second route that skips the validator, a value that silently loses fields across a re-entry. Read-only: never modify files, commit, or post anywhere.

Read `$ARTIFACTS_DIR/review/scope.md` first. In light mode, verify prior seam findings first, then examine only the delta.

**A seam** is where a value crosses to something that must interpret it: serialization, process/language boundaries, events, persisted formats, pause/resume re-entry, load-time→run-time handoffs. A plain function call is not a seam.

## The defect is never in the diff

The added code is usually correct in isolation; what is wrong is the counterpart it now disagrees with — which is not in the diff. **For every site the change touches, leave the diff and find its counterparts:**

- Edits one member of an enumerated set (a field list, a walker, a per-variant dispatch) → find **every other member**; one of them likely needed the same edit.
- Adds a syntax form, key, or shorthand → find **every consumer of that syntax**; the route that doesn't know the new form admits it unchecked.
- Adds a field on a resume/retry/rehydrate path → diff the field set against the **primary construction path**.
- Adds a variant to a union → find **every switch over it**; look for the silent default.
- Adds a validation → count **every route in** to what it guards; one validator and three ways in is two holes.
- Writes a value something else reads → read **the reader**; a formatter/parser pair written at different times and nowhere checked to be inverses.

Two heuristics do most of the work: **"this is the Nth"** — if the change edits the Nth thing of a kind, N−1 others exist; check them. And **the change's own comments are a confession** — "keep in sync", "must match", "also update" name the missing type; when two sync comments describe the same set, check they agree: **a contradiction between them is drift already shipped**, your strongest possible finding.

Mechanical starting points that pay off: grep the changed area for the KEEP-IN-SYNC comment family, phase assertions ("should never happen", "must be resolved by now"), `if (x && …)` guards on a value that crossed a persistence or re-entry boundary (a dropped value becomes indistinguishable from a legitimately absent one — diff the field set on both sides of any resume, retry, or rehydrate), and substring assertions in tests against a value that ought to be structured. A signal is not a finding — each is where to start reading, not what to report.

## The bar

**Name both sides or you have no finding.** A lone untyped value at a framework edge is the platform, not a defect. Bound the search to two hops from changed lines — do not audit the codebase. Honest duplication across a build boundary the project cannot deduplicate (or documents as deliberate) is a carve-out, not a finding — and prove the boundary by reading the build manifest, never by assuming it; when the sides truly cannot import one definition, the most you owe is a note recommending a conformance test. A missing discriminator (kind/type field) is reportable only with growth evidence — an open ticket, a TODO, a sibling payload that already has two kinds, a one-case switch: **no growth evidence, no finding.**

When you clear a seam, your reason must be a **quotation** from the code or build config — never your own characterization. If you cannot quote it, mark it unverified and leave it off the clean list.

## Output

Write `$ARTIFACTS_DIR/review/seams.md`: each finding with severity (Critical if it already failed or fails silently on a supported path; Important otherwise), **both sides quoted with `file:line`**, what the missing type would carry, the concrete failure, and the smallest change that keeps the type. Then carve-outs applied, and the examined-and-clean list with its quotations. In light mode, a verdict per prior finding. No findings is a valid result — but only quoted silence.

Verify every `file:line` cited is real, then reply with one line: findings count by severity.
