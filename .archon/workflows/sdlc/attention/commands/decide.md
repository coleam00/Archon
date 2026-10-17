# Decide Whether a Stage's Ending Needs a Person

This run's `$INPUTS.stage` stage has ended. Decide whether its ending already has a next step, or whether it stops where only a person can take it forward. When it stops, write the attention item that person answers. You read and decide only: the repository, the forge and the tracker stay exactly as you found them. The next node raises your item, and the run continues on the answer.

The stage's typed outcome:

$INPUTS.outcome

Its reports are in `$ARTIFACTS_DIR`, as the stage wrote them: `triage.md`, `plan.md`, `investigation.md`, `implementation.md`, `review/scope.md` and `review/report.md`, whichever exist. Read the report that explains the ending before you decide; never decide from a reason code alone.

The operator's request, the message that started this run:

$ARGUMENTS

## Decide

- `done`: the ending is final, or it carries its own next step. A delivery that is ready: its pull request is out of draft for review and merge. A plan that is ready to build. A triage that routed the item or found no action owed. An investigation that refuted the claim. A review that found the change not ready: its findings are on the pull request for the author. A review that is Ready on a pull request that is not a draft.
- `ask`: the run is over and nothing takes it forward. A delivery that ended not ready, for any reason: its rounds ran out, a review asked for a replan or a person, the implementer was blocked, or CI stayed red. A plan or a triage that stopped on a question only a person can answer: open questions, a blocked item, or an item that needs contract work. An investigation that could not root the cause. A review that is Ready on a pull request that is still a draft. Read the pull request's draft state from the forge: with the GitHub CLI (`gh pr view <number> --repo <host>/<path> --json isDraft`) unless `ARCHON_SDLC_FORGE` is `forge`; then through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, as `<argv...> forge pr.view --json --data '{"selector":{"kind":"number","ref":{"repo":{"host":…,"path":…},"number":…}}}'`, whose answer carries `is_draft`.

Declare `pull_request`: the pull request the stage worked on, as its repository (`host` and `path`) and `number`, or null when it worked on none. Declare `reason`: one line a person can check.

## The attention item

Only on ask; null on done. A person reads it without opening the run, so each field stands alone:

- `what`: what ended, and the decision, in plain words.
- `why`: what happens if it is decided either way.
- `recommendation`: the id of the choice you recommend, `why`, the `evidence` it rests on, your `confidence`, and what evidence `would_change` it.
- `choices`: each choice's `id` is what it does, from this fixed set, with a short `label` and what it `does` for this item:
  - `rerun`: run this stage again in this run, starting from the work it was given, this item, and the person's note. Offer it when another pass can move the work: a delivery that ran out of rounds or needs a decision the note can give, a plan or a triage whose question the answer settles.
  - `ready`: take `pull_request` out of draft, for review and merge. Offer it only for a Ready verdict on a draft pull request.
  - `finish`: end the run with the outcome as it stands. Always offer it.
- `if_unanswered`: what waiting costs: the run stays paused and spends nothing, and say what goes stale meanwhile, such as a branch falling behind its base.
- `links`: the pull request, the issue when there is one, and the report paths under `$ARTIFACTS_DIR` that hold the evidence.
