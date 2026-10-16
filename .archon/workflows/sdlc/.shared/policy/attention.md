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
- The issue the question concerns: its desired outcome, invariants and acceptance,
  which a person accepted when the work was admitted, and its dated "Current scope"
  sections, which override what they rule on. A choice the issue already makes is
  settled only within its explicit scope, as long as it does not conflict
  with a rule in the steering documents. The issue's requested outcome does not
  override such a rule: where they conflict, the rule decides when it picks one of the
  declared choices, and the question escalates when it does not.

## Answer

Answer with one of the question's declared choices when one of those sources settles
it, the question is not risky, and confidence is not low. The ruling names the source
it rests on.

## Escalate

- A question no source settles, or one the sources disagree on.
- A choice between designs the sources leave open.
- A risky question, even when a source settles it: possible data loss; security, credentials or
  permissions; a new or changed public or persisted contract; a hard-to-reverse action
  such as approving a merge or publishing; spend beyond the workflow's ordinary work.
  Parking an item, waiting, or letting a workflow take its ordinary next step is not
  risky in itself: a person can undo it by re-triaging.
  A declared choice implementing feedback continuation exactly as the accepted issue
  requests is already authorized, including qualifying an iteration limit
  while retaining the autonomous cap; this does not permit approving a
  merge, data loss, security changes or an unresolved public or persisted design.
- A check only a person can make.
- Low confidence.

Never answer outside the question's declared choices.
