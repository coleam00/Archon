# Attention items

This is the SDLC pack's default guidance for the question a queue leaves when a
decision belongs to a person. A project adds to it with its own
`.archon/sdlc/policy/attention.md`: the agent reads this default first and the
project's file after it, and where the two conflict, the project's line wins.

The question is left on the issue's item as an ask and the run ends; the answer starts
the next run. A maintainer decides from the ask without opening the run. You write its
fields exactly as they are shown: no step rewrites or completes them.

- `question`: one sentence that names the item, by issue or pull request number, and
  the decision, and that can be answered by picking an option.
- `context`: what is at stake, as prose. Say what happens if it is decided either way,
  the evidence your recommendation rests on and what evidence would change it, and
  whether the item waits, blocks other work or goes stale as the base moves while
  nobody answers. End with the links the decision rests on, one per line, such as the
  issue, the pull request, the review report, the failing runs, and the run.
- `options`, when the prompt has you write them: at least two, each a kebab-case `id`,
  what it `does`, what it `cost`s, and the fields the prompt names, such as the build
  queue's `effect` and `ruling`. A ruling is written into the issue body as a dated
  scope section when its option is chosen, so write it as the contract sentence the
  next run reads, such as "Downstream nodes may gate on head_matches too". Leave it
  empty when the option changes no scope. Every ask also offers `other`, answered with
  text, for an answer none of yours covers; never declare an option with that id.
- `recommendation`: the `option` you recommend and `why`, in a sentence. Every question
  recommends one of its options.

Two things make the question unaskable, and the run fails at its end, after its
decision is recorded: two options with one `id`, and a `recommendation.option` that is
not, letter for letter, the `id` of an option you declared. Check both before you answer.
