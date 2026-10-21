# Answer How a Build Round Ended

A build round is one `archon-ship` run on the item. Read how it ended and decide what the queue does next: the item is done, the queue continues it with another round, or a maintainer must decide. The next node performs what you declare and reads it back: it pushes commits the round left unpushed, records your decision, and raises your attention item. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The item: `$INPUTS.url`. Its issue, title and body, is in `$ARTIFACTS_DIR/build/issue.md`; read the body from there, because it is the text this decision is about. Dated "Current scope" sections are part of the contract and override what they rule on.

## The round

- This round's ending, as `archon-ship`'s report declared it: `$INPUTS.ending`. Its artifacts are in `$ARTIFACTS_DIR`: `triage.md`, then `plan.md` or `investigation.md` when they exist, `implementation.md`, and `review/report.md`.
- The earlier rounds, oldest first, each with its own `artifacts` directory: `$INPUTS.rounds`.
- The item's work item: `$INPUTS.record`. Under `facts.build` is every decision the queue made on it, with any maintainer's answer. Null means no queue has recorded it.

Read the SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `build.md` and `rulings.md`; the pack's defaults are in `$INPUTS.policy_defaults`. Read the default first, then the project's file when it exists: the project's file adds to the default, and where the two conflict, the project's line wins. Read the project's steering documents, direction, `engineering.md` or `architecture.md`, only when a stop's question turns on what they rule.

## Decide

Read the report's `reason` and summary, then the artifact that explains it: the plan's open questions, the review report's findings, the implementer's dispositions. Read what a finding or a question says; never decide from the reason code alone.

- `done`: the round delivered. The pull request's latest review comment says Ready at the pull request's current head commit, and CI marked it ready. A Ready verdict at an older commit does not count: commits were added after the review, and the item is continued.
- `continue`: another round can finish the work without a person, because the contract already answers what stopped it. A correctable review finding, CI red the change caused, and a conflict with the base continue. A stop whose question the issue body's dated sections, the project's steering documents or the rulings answer continues, and the brief gives that answer with its source. When the round's pull request stands and only that question stopped it, the brief says to finish that pull request with the answer: the next round continues it, and does not plan the work again. Only a review that asked for a different design (`replan`) sends the next round back to planning. A stop that names as a blocker work a later step owns, such as a review, CI, marking the pull request ready or the maintainer's merge, is a false blocker: continue, and say in the brief that those steps follow.
- `ask`: the contract does not answer it. A planning question that would relax a constraint the maintainer stated, scope the contract does not name, a choice between designs the documents do not settle, a check only a person can make, or a failure you cannot explain.

When the round left commits that are on the checkout but not on its pull request's head, declare that pull request in `push` with its repository and number, whatever you decide; otherwise `push` is null. Compare `git rev-parse HEAD` with the pull request's head commit to know.

## At the round cap

`$INPUTS.at_cap` is true when the queue has run several rounds on this item since its scope last changed. Then, before you `continue`, compare the rounds' review findings: read each earlier round's `review/report.md`. Continue when the work converges: the findings shrink, repeat a defect being fixed, or are corrections of one kind the next round can finish. Ask the scope question instead when each round's review found new defects the round before did not have, such as regressions the corrections introduced or one problem class surfacing in place after place: another round spends more without settling it. The scope question's attention item says how many rounds ran, the scope question in plain words, what another round costs, and what narrowing or re-planning would change; its evidence names the rounds' new findings by report path, and a choice's `ruling` can carry a narrower acceptance or a design constraint.

## The brief

On continue, `brief` is the target the next `archon-ship` run starts from cold. It names the issue by URL and says the issue body, including its dated scope sections, is the contract. Then it names the open pull request by URL and branch, says why this round stopped, and says what the next round does about it: the findings to correct with their report path, the answer to the stop with its source, or the steps that follow a false blocker. It does not restate or widen the contract. On ask, `brief` is what the next round starts from if the maintainer chooses to continue. On done it is empty.

## The attention item

Only on ask; null otherwise. A maintainer reads it without opening the run, so each field stands alone:

- `what`: the item and the decision, in plain words.
- `why`: what happens if it is decided either way.
- `recommendation`: the id of the choice you recommend, `why`, the `evidence` it rests on, your `confidence`, and what evidence `would_change` it.
- `choices`: at least two, each a kebab-case `id`, a short `label`, what it `does`, its `effect` (`continue` launches the next round from the brief; `park` stops the queue working the item until a re-triage), and the `ruling` written into the issue body as a dated scope section when it is chosen. Write the ruling as the contract sentence the next run reads; leave it empty when the choice changes no scope. The queue adds `other` itself, for an answer none of your choices covers; don't declare it.
- `if_unanswered`: whether the item waits, blocks other work, or goes stale as the base moves.
- `links`: the pull request, the review report and the run.

Declare `reason`: one line a maintainer can check.
