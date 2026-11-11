# Triage policy

This is the SDLC pack's default triage policy. A project adds to it with its own
`.archon/sdlc/policy/triage.md`: triage reads this default first and the project's file
after it, and where the two conflict, the project's line wins.

- **Scope.** Judge whether an item is in scope against the project's direction
  document. When the project has none, say so rather than invent its scope.
- **Ready means a run can start.** An item is ready when it says what outcome is
  wanted clearly enough for one of the routes to start from it. A strong item states
  the problem, why it is worth solving, why now, the outcome, the invariants and
  acceptance. Triage records which of these the item states and which it leaves out,
  for the next stage to read; one that is missing is not by itself a reason to refuse.
  Scale the bar by the work:
  - A small bug needs the problem, the expected behavior and a way to recognise the
    fix, such as a reproduction, a failing test or a log.
  - A larger change, or one that leaves product or design choices open, needs a clear
    outcome. Planning shapes the rest and raises what it cannot decide.
- **Plan an item that is routable but under-shaped.** When the outcome is clear and
  elements are missing or choices are open, route `plan` and say in the handoff what is
  missing, so the planner shapes it. Size, length and vagueness are reasons to plan,
  never reasons to split.
- **Deliver directly when the work is small and specified.** The item names the
  behavior to change and how to recognise the result, the current code shows where it
  lives, and no design choice is left. A well-specified small defect is delivered.
- **Investigate only a symptom whose cause is unknown or disputed.** A defect whose
  cause the report and the current code already show is not investigated.
- **Ask when no route can start.** An item that does not say what outcome is wanted, or
  that leaves so many questions open that planning could not start, gets questions:
  at most five, each one specific enough for its author to answer. Triage never
  rewrites the author's text.
- **Closing without a person.** Only two kinds of item may be closed without a
  maintainer: a duplicate of an issue that is still open, and an item whose outcome a
  merged change already delivered. Name that open issue or that merged change.
- **Everything else goes to a maintainer.** An item that looks closable for any other
  reason (out of scope, obsolete, superseded, rejected by direction, or a duplicate of
  a closed item) waits for a maintainer's decision, with the reason it looks closable.
- **Split or build whole.** A large item, a PRD, an epic or a bundle of tasks, is
  built as one work item unless building it whole would not work. One run can plan
  and deliver a large change, and one pull request for one outcome is easier to review
  and verify than several that only make sense together. Splitting is right only for
  a reason the item itself shows:
  - its pieces are separate outcomes, each worth having on its own, so one pull
    request would mix changes no reviewer can judge as one, and one piece stalling
    would hold back the rest;
  - a piece must merge and be used before a later piece can be built or judged, such
    as a measurement that must collect real data first, or a contract that must land
    before the work built on it;
  - the work spans so many packages and surfaces, each with its own acceptance, that
    no single run could finish it and no reviewer could read it as one change.

  Length, a long acceptance list, size `l`, and a "PRD" or "epic" title are not
  reasons on their own.
- **How each kind splits.** A split breaks the item into the fewest pieces that each
  prove something on their own, and files only the piece that comes next.
  - A **PRD** splits into phases, not tasks. A phase proves a desired outcome: usually
    a thin slice end to end, but it can be most of the thing, or all of it in one go.
  - An **epic**, one larger outcome, splits into vertical increments, each leaving the
    product working.
  - A **bundle** of separate tasks with no shared outcome is not sliced: each task is
    filed as it is. It is ready when each task is clear enough to become its own item;
    the contract's six elements belong to each task and are judged when that task
    comes back through triage.

  Only the current phase or increment is filed: the first one not yet done, unless it
  must wait on real use of what is already delivered. The later ones are recorded on
  the item as a short plan, each with what the earlier work must show before it is
  filed, and a later split files them. A parent's kind does not change because part of
  it is already delivered. An item a split already filed issues from is never built
  whole: its split comment lists them, and a re-triage routes it `split` again, which
  files the next phase, or leaves it waiting.
- **PRDs.** A PRD is a hypothesis-driven release: it says that shipping something will
  change something observable, and the work is how to find out. Tell it by what the
  item asks for, not by its headings or title. It is ready only when it states all
  three of: a hypothesis (if we ship this, what changes); the signal that proves or
  disproves it, with the command that measures that signal; and a threshold the
  signal must reach, with the time window it is judged over. A command that does not
  exist yet is acceptable when the PRD says what it must print; the work then builds
  the measurement first. A PRD missing any of the three is asked for it: the questions
  name the missing piece. The bar holds whether the PRD is split or built whole. The verdict, judged
  on real use over the window after release, is not a piece of work: the PRD stays
  open for it either way, so it is never on its own a reason to split. A list of tasks
  under a PRD title, with no hypothesis, is not a PRD: it is judged as an epic or a
  bundle, and is asked for its hypothesis when it was meant to be a PRD.
