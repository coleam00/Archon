# Land policy

Archon's additions to the SDLC pack's default land policy. The land stage reads the
default first and this file after it.

## Every merge is asked

Nothing merges until an operator approved the pull request at exactly its head: the
land stage asks for every pull request, with what it would have done as its
recommendation. An approval holds only at the head it named. Under the default's looser
rule, whether an earlier approval still held after a conflict round was the agent's
reading, and it let a non-merge commit through (pull request 5815). This holds until an
approval is held at a commit by an engine rule (issue 5769).

## Unclear: the land stage asks

- Changes to the SDLC pack itself or anything else under `.archon/` (its workflows,
  commands, scripts, packs and policy documents), even a test-only change.
- The workflow language: its YAML surface, schemas or validation.
- The plugin protocol, or any contract an outside plugin or provider builds against.
