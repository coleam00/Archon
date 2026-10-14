# Triage policy

Archon's triage policy. It is the SDLC pack's default plus where to find Archon's
direction and engineering values.

- **Scope.** Judge whether an item is in scope against
  [`.archon/direction.md`](../../direction.md). Judge size, complexity and whether the
  requested approach fits the codebase against
  [`.archon/engineering.md`](../../engineering.md).
- **Closing without a person.** Only two kinds of item may be closed without a
  maintainer: a duplicate of an item that is still open, and an item whose outcome a
  merged change already delivered. Name that open item or that merged change.
- **Everything else goes to a maintainer, with a recommendation.** An item that looks
  closable for any other reason (out of scope, obsolete, superseded, rejected by
  direction, or a duplicate of a closed item) waits for a maintainer's decision. Give
  the reason it looks closable and what you recommend: close, keep and route, or ask
  the author a question. Cite the passage of `direction.md` or `engineering.md` the
  recommendation rests on.
