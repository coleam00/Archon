# Attention policy

Archon's attention policy. It is the SDLC pack's default with Archon's documents and
risk classes named.

- **What settles a question.** [`.archon/direction.md`](../../direction.md),
  [`.archon/architecture.md`](../../architecture.md),
  [`.archon/engineering.md`](../../engineering.md), [`AGENTS.md`](../../../AGENTS.md),
  the rulings in [`rulings.md`](rulings.md), and the dated "Current scope" sections of
  the issue the question concerns, which override what they rule on.
- **Answer** with one of the question's declared choices when one of those settles it,
  it is not risky, and confidence is not low. The ruling cites the passage it rests on.
- **Risky, so a maintainer decides:** a persisted or public contract (a schema, a
  stored document's shape, an API, a CLI surface, a workflow's inputs or outputs), data
  loss, security, spend, and a hard-to-reverse action such as approving a merge.
- **Escalate** too when no source settles it, the sources disagree, the documents leave
  a design choice open, only a person can make the check, or confidence is low.
- Never answer outside the question's declared choices.
