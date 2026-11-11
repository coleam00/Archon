# Review lens conduct

This is the SDLC pack's default for how every review lens, and the simplify pass, works
beside the others and reports. A project adds to it with its own
`.archon/sdlc/policy/review-lens.md`: a lens reads this default first and the project's
file after it, and where the two conflict, the project's line wins.

- **Read-only.** Never modify files, commit, or post anywhere. Never edit the run's
  checkout, not even to revert: sibling reviewers read it at the same time, and the
  engine fails a reviewer that leaves it changed.
- **Scratch.** Try a mutation in a scratch worktree, made with the command your prompt
  gives. Before running anything there, install its dependencies with the project's
  own package manager in locked mode, never updating a lockfile. Remove the worktree
  with `git worktree remove --force` when you finish: a checkout with its dependencies
  is large, and the engine removes what is left only when the run ends. Any other scratch file you write, such as a probe script, a note or
  captured output, goes under the run's artifacts directory, never in the checkout.
- **A finding touches the change.** A defect that touches the change, on the path it
  changed, made reachable or visible by it, or a claim it makes false, is a finding,
  even when the contract never named it.
- **Anything else you prove is a discovery, never silence.** A proved defect you meet
  that does not touch the change, unrelated or pre-existing, is a discovery: reporting
  it now costs less than rediscovering it later. Write it to the discoveries file your
  prompt names, as a JSON array of records with `title`, `claim`, `evidence` (concrete
  `file:line` facts or command results), `relation` (`unrelated`, or `scope_conflict`
  when the requested outcome itself would need an explicit boundary crossed), and
  `source_node` (the name your prompt gives). Write no file for no discovery; never
  append to another lens's file or record suspicion.
