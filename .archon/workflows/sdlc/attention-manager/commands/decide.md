# Decide One Attention Item

A workflow paused on a question and is waiting for a person. Decide whether the project's own documents already answer it. If they do, answer with one of the choices the question declares and say what the answer rests on. If they do not, or the question is risky, escalate it to a person. You judge; the next node makes the one write your decision calls for. Write nothing to the tracker, the repository, the state store or the attention queue yourself, and leave the checkout exactly as you found it.

## Read first

- The item: `$INPUTS.item`. Its `message` is what the asking workflow wrote: usually the decision, why it matters, its own recommendation with evidence and confidence, the choices and what each does, and links. `options` are the declared choices; an answer is one of their `id`s, copied exactly. `labels` say which kind of question it is, and `pausedAt` when it was asked.
- The paused run's artifacts, under the item's `context.artifactsDir`: what that run read and decided from, including the issue body as it read it where it keeps one. Follow the message's links to the evidence they name.
- The issue or pull request the item concerns. Its dated "Current scope" sections are part of its contract and override what they rule on. In live mode (`$INPUTS.mode` is `live`) read its current body and comments with the tracker's read-only CLI.
- The SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `attention.md` and `rulings.md`; the pack's defaults are in `$INPUTS.policy_defaults`. A project's file replaces the default whole: when it exists, do not read the default.
- The project's steering documents `attention.md` names, where the project has them. Read the sections that rule on the question, not every document whole.

In eval mode (`$INPUTS.mode` is `eval`) the item was answered after it paused, and the tracker's current body and comments may already record that answer. Do not read them. Read the issue only from the paused run's artifacts, and judge from what was true at `pausedAt`.

## Decide

- `answer` only when a steering document, a dated scope section or an earlier ruling settles the question, the policy does not count it as risky, and you are confident. The asking workflow's recommendation is evidence, not a ruling: answer with it only when a document settles it.
- `escalate` otherwise: the documents do not settle it, they conflict, the choice is risky as the policy defines risk, it needs a check only a person can make, or your confidence is low. When in doubt, escalate.

## Output

- `decision`: `answer` or `escalate`.
- `choice`: on answer, the declared option `id` you chose. On escalate, the `id` you would recommend, or empty.
- `ruling`: on answer, the ruling as one or two contract sentences the next run reads, naming what it rests on. On escalate, why a person must decide.
- `sources`: each document the ruling rests on, as a path with its section, a dated scope section by its heading, or a URL. Empty when nothing settles it.
- `confidence`: `low`, `medium` or `high`.
- `reason`: one line a person reviewing the decision can check.
