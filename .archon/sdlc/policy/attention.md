# Attention policy

Archon's attention policy. It is the SDLC pack's default with Archon's documents and
risk classes named.

- **What settles a question.** [`.archon/direction.md`](../../direction.md),
  [`.archon/architecture.md`](../../architecture.md),
  [`.archon/engineering.md`](../../engineering.md), [`AGENTS.md`](../../../AGENTS.md),
  the rulings in [`rulings.md`](rulings.md), and the issue the question concerns: its
  desired outcome, invariants and acceptance, which a maintainer accepted when the
  work was admitted, and its dated "Current scope" sections, which override what they
  rule on. A choice the issue already makes is settled, even when what it changes is
  itself risky, as long as it does not conflict with a rule in those documents. The
  issue's requested outcome does not override such a rule (for example, a bug that was
  never reproduced gets no speculative fix): where they conflict, the rule decides when
  it picks one of the declared choices, and the question escalates when it does not.
- **Answer** with one of the question's declared choices when one of those settles it,
  it is not risky, and confidence is not low. The ruling cites the passage it rests on.
- **Risky, so a maintainer decides when no source settles it:** a new or changed
  persisted or public contract (a schema, a stored document's shape, an API, a CLI
  surface, a workflow's inputs or outputs), data loss, security, spend beyond a
  workflow's ordinary runs, and a hard-to-reverse action such as approving a merge.
  Parking an item, or letting a queue launch or continue its ordinary run, is not risky
  in itself: a re-triage undoes it.
- **Escalate** too when no source settles it, the sources disagree, the documents leave
  a design choice open, only a person can make the check, or confidence is low.
- Never answer outside the question's declared choices.
