# Attention items

This is the SDLC pack's default guidance for the attention item a queue raises when a
decision belongs to a person. A project adds to it with its own
`.archon/sdlc/policy/attention.md`: the agent reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

A maintainer decides from the item without opening the run. You write the fields of the
question exactly as they are shown: no step rewrites, checks or completes them.

- `question`: everything the maintainer reads besides the options, as prose. Its first
  sentence names the item, by issue or pull request number, and the decision. Then say
  what happens if it is decided either way, the evidence your recommendation rests on
  and what evidence would change it, and whether the item waits, blocks other work or
  goes stale as the base moves while nobody answers. End with the links the decision
  rests on, one per line, such as the issue, the pull request, the review report, the
  failing runs, and the run.
- `options`: at least two, each a kebab-case `id`, a short `label`, what it `does`, and
  a `value` holding its `effect`, from the list the prompt gives, and its `ruling`. The
  chosen ruling is written into the issue body as a dated scope section, so write it as
  the contract sentence the next run reads, such as "Downstream nodes may gate on
  head_matches too". Leave it empty when the option changes no scope. The question adds
  an `other` option itself, for an answer none of yours covers; never declare an option
  with that id.
- `recommendation`: the `option` you recommend, `why` in a sentence, and your
  `confidence`. Every question recommends one of its options.

Two things make the question unaskable, and the run fails on it after its decision is
recorded: two options with one `id`, and a `recommendation.option` that is not, letter
for letter, the `id` of an option you declared. Check both before you answer.
