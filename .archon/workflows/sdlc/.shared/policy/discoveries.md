# Discoveries policy

This is the SDLC pack's default policy for deciding run discoveries. A project
replaces it whole with its own `.archon/sdlc/policy/discoveries.md`, which may be
nothing more than a pointer to documents the project already has.

- **File** a defect that is real at the base, worth an issue of its own, and covered
  by no open issue or pull request. Write a full brief: problem, why, why now, outcome,
  invariants and acceptance. Related discoveries one change would fix may share an
  issue.
- **Track** a discovery an open issue already covers. Add evidence to that issue only
  when the discovery shows something the issue does not already say; otherwise post
  nothing.
- **Drop**, with a one-line reason, a discovery that is:
  - already fixed at the base;
  - fixed by an open pull request;
  - a decision about one run's or one pull request's own scope;
  - too minor for an issue of its own, better fixed in passing;
  - speculative, with no failure shown;
  - impossible to verify by reading the code.
- **A drop stays dropped** unless new evidence changes the reason it was dropped.
- **Ask** a maintainer only when the project's documents, rulings and earlier answers
  cannot decide it, and say what you recommend. Judge scope against the project's
  direction document the way triage does.
