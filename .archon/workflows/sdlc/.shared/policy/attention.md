# Attention policy

This is the SDLC pack's default policy for the attention manager. A project replaces it
whole with its own `.archon/sdlc/policy/attention.md`, which names its own steering
documents and risk classes.

The manager answers a paused question only when the project has already answered it,
and leaves everything else to a person.

## What settles a question

- The project's steering documents, where it has them: its direction document, its
  architecture and engineering documents, and its contributor guidance for agents.
- Its rulings document (`rulings.md`, read as this pack reads policy).
- The dated "Current scope" sections of the issue the question concerns, which
  override what they rule on.

## Answer

Answer with one of the question's declared choices when one of those sources settles
it, the question is not risky, and confidence is not low. The ruling names the source
it rests on.

## Escalate

- A question no source settles, or one the sources disagree on.
- A choice between designs the sources leave open.
- A risky question: possible data loss; security, credentials or permissions; a public
  or persisted contract; a hard-to-reverse action such as approving a merge or
  publishing; spend.
- A check only a person can make.
- Low confidence.

Never answer outside the question's declared choices.
