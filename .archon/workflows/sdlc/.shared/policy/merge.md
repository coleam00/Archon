# Land policy

This is the SDLC pack's default policy for landing a change. A project adds to it with
its own `.archon/sdlc/policy/merge.md`: the land stage reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

The land stage merges on its own when the case is clear, and asks an operator when it
is not. The gate is not policy: no pull request merges unless the latest review of it
approved its head, what the project's CI setting trusts passes there (green checks, or
under `ci: none` a passing full validation the host stage ran at that head), it targets
the item's landing branch and that branch's CI is not red, whatever this document says.
The land stage never pushes, so a review for another commit means someone pushed after
the review, and the pull request goes back to be built and reviewed. An open review
thread holds the merge only when it raises a defect in what the pull request changes.
A thread on code the pull request doesn't change or make reachable, such as one that
arrived with a merge of the base branch, doesn't hold it. Nor does a request for a
guard, a check or a test against an input or state no supported path produces. Judge
each claim in a thread on its own: a thread that also raises a defect still holds the
merge.

## Clear: the land stage merges

- A bug fix whose change stays inside the defect it fixes and the tests that prove it.
- A small feature: one coherent behavior, a few files, with its tests and docs.
- Tests, documentation and comments.
- A pull request an operator approved for merge at its current head, or at an earlier
  head when everything since is merges of the base branch and the resolution of their
  conflicts, and the review approved the current head. Anything else since the
  approved head, or any doubt about it, voids the approval, and the stage asks again.

## Unclear: the land stage asks

- A persisted schema, a migration, or any stored or wire format.
- Authentication, credentials or permissions.
- Large changes: many files or packages, or a rewrite of a subsystem.
- Partial work: one part of a multi-part plan, or a pull request whose review lists
  contract items as not yet met.
- Anything a release or the project's direction depends on without a ruling.

## Before a merge

- **Fix in the build stage.** A pull request that fails the gate for a reason a builder
  can correct, such as a review thread that raises a defect in the change, a review
  for another commit, a conflict with the base branch, or CI red that the change
  caused, goes back to its builder with what is wrong, whether it is clear or not.
- **Ask an unclear pull request early.** Once the review approved its head, an unclear
  pull request is asked, even while its CI is pending or it conflicts, so the decision
  runs alongside the rest. The approval is pinned to that head.
- **Merge when the merge is clean.** A pull request whose review approved its head,
  whose CI is green at that head, and which the forge reports merges into the base
  branch with no conflict merges at that head, even when the base branch moved since.
  The base branch's CI on the merge judges the combined result.
- **One rerun for red elsewhere.** CI red in code the pull request does not touch gets
  one rerun of the failed jobs. Red again after it counts as the change's.
- **The base branch comes first.** The land stage judges the base branch's CI before
  the pull request, and while it is red nothing merges. It names what each failing job
  points at and the pull requests merged since it was last green, so one can be
  reverted or fixed forward, or its failed jobs rerun when no recent merge touched the
  red code. The pack cannot rerun them itself: the forge reruns checks only on a pull
  request.

## How it merges

- **Squash.** A pull request merges as one squashed commit. A project that keeps its
  commits says `merge` here instead.
