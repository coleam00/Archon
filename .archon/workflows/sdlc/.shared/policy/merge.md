# Merge queue policy

This is the SDLC pack's default policy for the merge queue. A project replaces it whole
with its own `.archon/sdlc/policy/merge.md`, which may be nothing more than a pointer to
documents the project already has.

The queue merges on its own when the case is clear, and asks a maintainer when it is
not. The gate is not policy: no pull request merges unless its trusted review verdict
says Ready at its head, CI is green at that head and no review thread is unresolved,
whatever this document says.

## Clear: the queue merges

- A bug fix whose change stays inside the defect it fixes and the tests that prove it.
- A small feature: one coherent behavior, a few files, with its tests and docs.
- Tests, documentation and comments.
- A pull request a maintainer approved for merge at its current head.

## Unclear: the queue asks

- Changes to the SDLC pack itself: its workflows, commands, scripts or policy documents.
- A persisted schema, a migration, or any stored or wire format.
- Authentication, credentials or permissions.
- The workflow language: its YAML surface, schemas or validation.
- The plugin protocol, or any contract an outside plugin or provider builds against.
- Large changes: many files or packages, or a rewrite of a subsystem.
- Partial work: one part of a multi-part plan, or a pull request whose review lists
  contract items as not yet met.
- Anything a release or the project's direction depends on without a ruling.

## Before a merge

- **Fix first, ask last.** A pull request that fails the gate for a reason the build
  queue can correct, such as an unresolved review thread, a verdict that is not Ready,
  or CI red that the change caused, goes back to the build queue with a brief, whether
  it is clear or not. Ask only when what is left is the decision itself.
- **Sync on conflict.** A pull request that conflicts with the default branch gets the
  default branch merged in, with the conflict resolved and generated files regenerated
  by their owning script. That push makes its verdict stale.
- **A stale verdict gets a delta review.** A pull request whose head moved after its
  review, by a sync or by anyone's push, is reviewed again from its last report before
  it merges.
- **One rerun for red elsewhere.** CI red in code the pull request does not touch gets
  one rerun of the failed jobs. Red again after it counts as the change's.
- **The default branch comes first.** While its CI is red, merge nothing. After each
  batch, check its CI; red there is raised to a maintainer.
