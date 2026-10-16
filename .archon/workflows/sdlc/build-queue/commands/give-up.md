# Decide Whether to Run Another Build Round

The queue has run several rounds on this item since its scope last changed, and the last one ended wanting another. Decide whether another round is likely to finish the work, or whether a maintainer should answer the scope question first. The next node records your decision and raises your attention item. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The item: `$INPUTS.url`. Its issue, title and body, is in `$ARTIFACTS_DIR/build/issue.md`.

## Read first

- The answer to the last round: `$INPUTS.answer`. Its brief is what another round would start from.
- The last round: `$INPUTS.ending` with its artifacts in `$ARTIFACTS_DIR`, or in a replay `$INPUTS.recorded` with its own `artifacts` directory.
- The earlier rounds, oldest first: `$INPUTS.rounds`. Each names its artifacts directory; read each round's `review/report.md`. The decisions the queue made on them, with any answer, are under `facts.build` in `$INPUTS.record`.
- The SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `build.md`; the pack's defaults are in `$INPUTS.policy_defaults`. A project's file replaces the default whole: when it exists, do not read the default.

## Decide

Compare the rounds' review findings. `continue` when the work is converging: the findings shrink, repeat a defect that is being fixed, or are corrections of one kind the next round can finish. `ask` when each round's review found new defects the round before did not have, such as regressions the corrections introduced or one problem class surfacing in place after place. That pattern says the approach or the scope needs a maintainer, and another round spends more without settling it.

On ask, the attention item asks the scope question. A maintainer reads it without opening the run, so each field stands alone:

- `what`: the item, how many rounds ran, and the scope question in plain words.
- `why`: what another round costs and risks, and what narrowing or re-planning would change.
- `recommendation`: the id of the choice you recommend, `why`, the `evidence` (the rounds' new findings, by report path), your `confidence`, and what evidence `would_change` it.
- `choices`: at least two, each a kebab-case `id`, a short `label`, what it `does`, its `effect` (`continue` launches the next round from the answer's brief; `park` stops the queue working the item until a re-triage), and the `ruling` written into the issue body as a dated scope section when it is chosen, such as a narrower acceptance or a design constraint. Leave it empty when the choice changes no scope.
- `if_unanswered`: whether the item waits, blocks other work, or goes stale as the base moves.
- `links`: the pull request, each round's review report, and the runs.

On continue, `attention` is null. Declare `reason`: one line a maintainer can check.
