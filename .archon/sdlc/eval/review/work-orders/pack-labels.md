# sdlc: the pack's labels have one owner, and stages write them as add and remove deltas

## Problem

The SDLC pack's label names live inside triage's verdict script. `STATE_LABEL`, `ROUTE_LABEL`, `COMPLEXITY_LABEL` and `PACK_LABELS` are declared at `.archon/workflows/sdlc/triage/scripts/verdict.ts:34-78`, and the code that writes them, `apply`, is at `verdict.ts:138-200`. Nothing else in the pack can use them without copying them.

`apply` also has two write paths that behave differently:

- On the `gh` source it adds and removes single labels (`verdict.ts:185-191`), so a label someone else adds at the same moment survives.
- On the `forge` source it reads the item's labels and writes the whole set back through `workitem.labels.set` (`verdict.ts:146-150`). A label another writer adds between the read and the write is dropped.

## Why

The approved intake design (`issue-intake-design.md`, revision 3, Q12) and the merge-queue design (Q16) turn the pack into stages joined by labels: one stage's exit label is the next stage's entry label. If each stage script declares its own names, or a binding passes stage A's exit label and stage B's entry label as two separate inputs, those are hand-synced pairs. AGENTS.md treats such a pair as a defect the moment it exists.

## Why now

Intake v1 is the first label-driven stage after triage, and the merge queue's first PR is designed on the same map. Both will write labels. If this lands first, each of them imports the map instead of growing a copy.

## Desired outcome

- `.archon/workflows/sdlc/.shared/labels.ts` owns every pack label: its name, color and description, and the typed maps from triage's decisions to labels. `PACK_LABELS` and its siblings move there from `verdict.ts`.
- The module exports one label write. It takes an item, the labels to add and the labels to remove, applies them as a delta, and reads them back. Triage's `apply` becomes a call to it, and later stages' outcome scripts use the same call.
- On the `gh` source the write keeps today's single add and remove. On the `forge` source it uses the seam's single-label add and remove once the forge seam's own single-label add and remove (item 1 of that work) lands. Until then it keeps the current read-and-set path, with a comment naming the race that seam work closes.
- Later issues add their own labels (intake's, triage's type and size labels) to this map rather than declaring them elsewhere.

## Invariants

- Triage's behaviour is unchanged: the same names, colors and descriptions; labels written only under `publish: true` after the item's identity is verified; area labels never created.
- Labels an operator adds concurrently survive a pack write on the `gh` source.
- The engine gains nothing. Label names stay pack configuration the user owns (`direction.md §software-factory`, `§user-owns-policy`).
- The pack stays portable: the map holds only the pack's own default names, nothing specific to this repository.

## Acceptance

- No pack script outside `.shared/labels.ts` declares a pack label name. Fixtures and tests may still name them.
- `.archon/scripts/__tests__/workitem-writes.test.ts` and `.archon/scripts/__tests__/forge-delivery.test.ts` pass without changes to their expectations.
- A test shows that one write adding one label and removing another leaves an unrelated label on the item, on the `gh` source.
- `bun run check:bundled` passes. `.shared` modules are already bundled (`packages/workflows/src/defaults/bundle-inventory.ts:155-160`).

## Out of scope

- The `.archon/sdlc/policy/labels.json` rename override and bindings generated from the map. Q12 defers both until a second user wants to rename labels.

## References

- Intake design Q12 and merge-queue design Q16, both in the operator's canvas. The merge-queue design is summarised on a separate issue.
- The forge seam work, item 1: the seam's label deltas.
