# Triage policy

This is the SDLC pack's default triage policy. A project replaces it whole with its
own `.archon/sdlc/policy/triage.md`, which may be nothing more than a pointer to
documents the project already has.

- **Scope.** Judge whether an item is in scope against the project's direction
  document. When the project has none, say so rather than invent its scope.
- **Closing without a person.** Only two kinds of item may be closed without a
  maintainer: a duplicate of an item that is still open, and an item whose outcome a
  merged change already delivered. Name that open item or that merged change.
- **Everything else goes to a maintainer.** An item that looks closable for any other
  reason (out of scope, obsolete, superseded, rejected by direction, or a duplicate of
  a closed item) waits for a maintainer's decision, with the reason it looks closable.
