# Asks

This is the SDLC pack's default guidance for the question a stage leaves when a
decision belongs to an operator. A project adds to it with its own
`.archon/sdlc/policy/asks.md`: the agent reads this default first and the project's
file after it, and where the two conflict, the project's line wins.

An ask is how a stage ends when it needs a decision. The run completes, the question
opens on the issue's item, and the answer starts the next run: the stage the chosen
option names, or this stage again with the answer as a decision already made. An
operator decides from the ask without opening the run. You write its fields exactly as
they are shown: no step rewrites or completes them.

- Ask only for a decision that is not yours: the item can be read two ways that lead
  to different changes, doing it gives up something the project holds to, or the
  answer depends on where the project is going. Do not ask what the policy, the rulings,
  the issue's comments or an earlier answer already decided, what you can find out by
  reading or running, or for permission to do your work.
- Find every decision you need, not only the first: the operator answers them as a
  set, and each further round costs a full run.
- `question`: one sentence that names the item, by issue or pull request number, and
  the decision, and that can be answered by picking an option.
- `context`: what is at stake, as prose. Say what happens if it is decided either way,
  the evidence your recommendation rests on and what evidence would change it, and
  whether the item waits, blocks other work or goes stale as the base moves while
  nobody answers. End with the links the decision rests on, one per line, such as the
  issue, the pull request, the review report and the failing checks.
- `options`: at least two, each a kebab-case `id`, what it `does` and what it `cost`s.
  When your prompt names a fixed set of options, offer exactly those ids: the answer's
  option is what starts the next stage, and an id the pack does not bind starts
  nothing. Every ask also offers `other`, answered with text, for an answer none of
  yours covers; never declare an option with that id.
- `recommendation`: the `option` you recommend and `why`, in a sentence. When you have
  no basis to choose, set it to `null` and say in `context` why you cannot choose and
  what would let you.
- `artifacts`: the reports the operator should read to decide, or an empty list.

An answer reaches every later stage on the item as `answers`, oldest first; where two
disagree, the later one holds. Build on an answer you are given; never ask it again.
