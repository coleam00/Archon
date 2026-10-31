# Triage policy

This is the SDLC pack's default triage policy. A project adds to it with its own
`.archon/sdlc/policy/triage.md`: triage reads this default first and the project's file
after it, and where the two conflict, the project's line wins.

- **Scope.** Judge whether an item is in scope against the project's direction
  document. When the project has none, say so rather than invent its scope.
- **Closing without a person.** Only two kinds of item may be closed without a
  maintainer: a duplicate of an issue that is still open, and an item whose outcome a
  merged change already delivered. Name that open issue or that merged change.
- **Everything else goes to a maintainer.** An item that looks closable for any other
  reason (out of scope, obsolete, superseded, rejected by direction, or a duplicate of
  a closed item) waits for a maintainer's decision, with the reason it looks closable.
- **PRDs and bundles of tasks.** An item can ask for more than one run's work. Tell
  the three shapes apart by what the item asks for, not by its headings or length:
  - A **PRD** is a hypothesis-driven release: it says that shipping something will
    change something observable, and the work is how to find out. It is ready only
    when it states all three of: a hypothesis (if we ship this, what changes); the
    signal that proves or disproves it, with the command that measures that signal;
    and a threshold the signal must reach, with the time window it is judged over.
    A command that does not exist yet is acceptable when the PRD says what it must
    print; the first issue split from it builds the measurement. A PRD missing any
    of the three needs contract work, and the proposed edits name the missing piece
    and what would fill it from the PRD's own content.
  - A **bundle of tasks** lists several pieces of work that each stand alone, with
    no hypothesis tying them together. It is ready when each task is clear enough
    to become its own item. The contract's six elements belong to each task and are
    judged when that task comes back through triage, not on the bundle.
  - A **single work item** is one outcome a run can deliver, however large. Judge it
    as any other item.

  A ready PRD and a ready bundle both route `split`. The split files one issue per
  piece of work, and each of those comes back through triage on its own, so judge
  the PRD's hypothesis bar here and leave each piece's contract to its own triage.
  A PRD that is really a list of tasks under a PRD title, with no hypothesis, is a
  bundle when its tasks stand alone, and needs contract work when it was meant to be
  a PRD.
