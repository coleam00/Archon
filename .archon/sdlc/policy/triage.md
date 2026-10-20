# Triage policy

Archon's additions to the SDLC pack's default triage policy. Triage reads the default
first and this file after it.

- **Scope.** Archon's direction document is [`.archon/direction.md`](../../direction.md).
  Judge size, complexity and whether the requested approach fits the codebase against
  [`.archon/engineering.md`](../../engineering.md).
- **Closing without a person.** The close leaves a comment on the closed item linking to
  the open issue or the merged change, so a reader can follow the work from there.
- **Everything else goes to a maintainer, with a recommendation.** Besides the reason an
  item looks closable, recommend what to do: close, keep and route, or ask the author a
  question. Cite the passage of `direction.md` or `engineering.md` the recommendation
  rests on.
