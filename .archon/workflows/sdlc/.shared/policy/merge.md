# Merge queue policy

This is the SDLC pack's default policy for the merge queue. A project adds to it with
its own `.archon/sdlc/policy/merge.md`: the queue reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

The queue merges on its own when the case is clear, and asks a maintainer when it is
not. The gate is not policy: no pull request merges unless its trusted review verdict
says Ready for its head, CI is green there and the default branch's CI is not red,
whatever this document says. The queue never pushes, so a verdict for another commit
means someone pushed after the review, and the pull request goes back to be reviewed.
An open review thread holds the merge only when it raises a defect in what the pull
request changes. A thread on code the pull request doesn't change or make reachable,
such as one that arrived with a merge of the default branch, doesn't hold it.

## Clear: the queue merges

- A bug fix whose change stays inside the defect it fixes and the tests that prove it.
- A small feature: one coherent behavior, a few files, with its tests and docs.
- Tests, documentation and comments.
- A pull request a maintainer approved for merge at its current head, or at an earlier
  head when everything since is merges of the default branch and the resolution of
  their conflicts, and the review is Ready at the current head. Anything else since the
  approved head, or any doubt about it, voids the approval, and the queue asks again.

## Unclear: the queue asks

- A persisted schema, a migration, or any stored or wire format.
- Authentication, credentials or permissions.
- Large changes: many files or packages, or a rewrite of a subsystem.
- Partial work: one part of a multi-part plan, or a pull request whose review lists
  contract items as not yet met.
- Anything a release or the project's direction depends on without a ruling.

## Before a merge

- **Fix in the build queue.** A pull request that fails the gate for a reason the
  build queue can correct, such as a review thread that raises a defect in the change,
  a verdict that is not Ready or is for another commit, a conflict with the default
  branch, or CI red that the change caused, goes back to the build queue with a brief,
  whether it is clear or not.
- **Ask an unclear pull request early.** Once its verdict is Ready at its head, an
  unclear pull request is asked, even while its CI is pending or it conflicts, so the
  decision runs alongside the rest. The approval is pinned to that head.
- **Merge when the merge is clean.** A pull request whose verdict is Ready, whose CI is
  green at its head, and which the forge reports merges into the default branch with
  no conflict merges at that head, reshape or not, even when the default branch moved
  since. The default branch's CI on the merge judges the combined result.
- **One rerun for red elsewhere.** CI red in code the pull request does not touch gets
  one rerun of the failed jobs. Red again after it counts as the change's.
- **The default branch comes first.** Each sweep judges its CI before any pull
  request, and while it is red nothing merges. Red in code no recent merge touched gets
  one rerun; red after that, or red in code a recent merge touched, is raised to a
  maintainer, naming the pull requests merged since it was last green, so one can be
  reverted or fixed forward.
