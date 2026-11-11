# Attention items

This is the SDLC pack's default guidance for the attention item a queue raises when a
decision belongs to a person. A project adds to it with its own
`.archon/sdlc/policy/attention.md`: the agent reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

A maintainer decides from the item without opening the run, so each field stands alone:

- `what`: the item and the decision, in plain words.
- `why`: what happens if it is decided either way.
- `recommendation`: the id of the choice you recommend, `why`, the `evidence` it rests
  on, your `confidence`, and what evidence `would_change` it.
- `choices`: at least two, each a kebab-case `id`, a short `label`, what it `does`, its
  `effect` from the list the prompt gives, and a `ruling`. The chosen ruling is written
  into the issue body as a dated scope section, so write it as the contract sentence
  the next run reads, such as "Downstream nodes may gate on head_matches too". Leave it
  empty when the choice changes no scope. The queue adds `other` itself, for an answer
  none of your choices covers; don't declare it.
- `if_unanswered`: whether the item waits, blocks other work, or goes stale as the base
  moves.
- `links`: what the decision rests on, such as the issue, the pull request, the review
  report, the failing runs, and the run.
