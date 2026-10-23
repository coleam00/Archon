# Discoveries policy

This is the SDLC pack's default policy for deciding run discoveries. A project adds to
it with its own `.archon/sdlc/policy/discoveries.md`: the decision reads this default
first and the project's file after it, and where the two conflict, the project's line
wins.

- **File** a defect that is real at the base, worth an issue of its own, and covered
  by no open issue or pull request. Write a full brief: problem, why, why now, outcome,
  invariants and acceptance. Related discoveries one change would fix may share an
  issue. Small consistency findings in one area, such as a stale comment, a small
  duplication or naming drift, share one `Cleanup: <area>` issue that one change fixes,
  with every item named in the brief with its evidence. A finding with a user- or
  operator-visible effect never joins a batch: it gets its own issue.
- **Track** a discovery an open issue already covers. Add evidence to that issue only
  when the discovery shows something the issue does not already say; otherwise post
  nothing.
- **Drop**, with a one-line reason, a discovery that is:
  - already fixed at the base;
  - fixed by an open pull request;
  - a decision about one run's or one pull request's own scope;
  - too minor for an issue of its own, with no user- or operator-visible effect and
    nothing in its area to batch it with;
  - speculative, with no failure shown;
  - impossible to verify by reading the code.
- **A drop stays dropped** unless new evidence changes the reason it was dropped.
- **Ask** a maintainer only when the project's documents, rulings and earlier answers
  cannot decide it, and say what you recommend. Judge scope against the project's
  direction document the way triage does.
