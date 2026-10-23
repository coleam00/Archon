# Route One Build Item

Decide whether the build queue launches its next run on this item, and write the brief the run starts from. Triage already decided the route; you keep it thin. The next node performs what you declare: it launches `archon-ship` with your brief, raises your attention item, or takes an already finished pull request out of draft. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The item: `$INPUTS.url`. Its issue, title and body, is in `$ARTIFACTS_DIR/build/issue.md`; read the body from there, because it is the text this decision is about. You may read the issue's comments and linked items with the tracker's CLI.

## Read first

- The item's work item: `$INPUTS.record`. It holds triage's verdict and five fields under `facts.triage`, and under `facts.build` every round the queue ran on it and every decision it made, with any maintainer's answer. Null means no queue has recorded it.
- The brief the last decision left for this launch: `$INPUTS.brief`. Empty means the item has not been launched yet, or a re-triage started it over.
- The SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `build.md` and `rulings.md`; the pack's defaults are in `$INPUTS.policy_defaults`. Read the default first, then the project's file when it exists: the project's file adds to the default, and where the two conflict, the project's line wins.
- The project's direction document, where it has one, only when whether the item is in scope depends on it.
- The item's pull request as the forge reports it now: `$INPUTS.pull_request`. It is the latest round's that recorded one, or the one triage routed it to continue; null means no round recorded one and triage named none. `$INPUTS.continues` is its number when it is open and its head is in the item's repository, else null: the one pull request this round may continue. Continue it unless the contract supersedes it: a dated scope section or a maintainer's recorded answer that says not to continue it, to replan, or to open a new pull request. Continuing means the round finishes it and pushes onto its head, so the same pull request updates. Ask when it is closed or merged, or its head lives in another repository, unless a dated scope section or a maintainer's recorded answer already rules on it.

## Decide

1. **Is the body a contract?** It must state, semantically rather than by heading, the problem, why it is worth solving, why now, the desired outcome, the invariants that must hold, and what acceptance looks like. Dated "Current scope" sections are part of it and override what they rule on. When one element is missing but the issue's own comments from a maintainer supply it, the brief carries it with its source. When nothing supplies it, ask.
2. **A bug is proved first.** When triage typed the item `bug` and it has not been launched yet, reproduce the symptom on the current checkout before launching: run the smallest probe that shows it, writing any probe file under `$ARTIFACTS_DIR/build/repro/`, never in the checkout. When the bug is in a browser surface, use the playwright-cli skill: invoke it as `$playwright-cli` where skills are invoked that way, and otherwise run the `playwright-cli` command, reading the skill's `SKILL.md` from the project's or your own skills directory for its usage. When you cannot reproduce it, launch only if you hold other concrete evidence of it, such as a failing test, a log or a recorded run, and name it. Otherwise ask.
3. **Is the work already done?** When the item's open pull request already meets the policy's Done at its current head and CI is green at that head, so only its draft state is left, declare `ready` instead of launching a round to do nothing. Set `ready_head` to that full head SHA, `brief` to one line saying so, and give the review and CI evidence in `reason`. On launch or ask, `ready_head` is null.
4. **Launch, or ask.** Launch a clear case. Ask when the policy says the case is unclear.
5. **Which pull request the round continues.** On launch, declare `continues`: `$INPUTS.continues` to continue the candidate, or null to start fresh. Null when the contract supersedes the candidate. A fresh round starts from the current base on a new branch and opens a new pull request; the checkout never carries the superseded pull request's head. Declare no other number; on ask and ready, `continues` is null.

## The brief

The brief is the target of `archon-ship`: one message another run starts from cold. It names the issue by URL and says the issue body, including its dated scope sections, is the contract. It does not restate or widen the contract. Add only what the run cannot learn from the body:

- for a continuation, the brief you were given, which records why the last round stopped and what was decided;
- an open pull request the work continues, by URL and branch;
- when the round starts fresh because the contract supersedes the candidate: that pull request by URL, the ruling that supersedes it, that the work does not continue or push onto it, and that once the replacement pull request opens the old one is closed as superseded by it;
- the reproduction, with its command and observed output, or the other evidence;
- a contract element a maintainer's comment supplied, with the comment's URL.

On ask, `brief` is what the next run starts from if the maintainer chooses to continue.

## The attention item

Only on ask; null on launch or ready. A maintainer reads it without opening the run, so each field stands alone:

- `what`: the item and the decision, in plain words.
- `why`: what happens if it is decided either way.
- `recommendation`: the id of the choice you recommend, `why`, the `evidence` it rests on, your `confidence`, and what evidence `would_change` it.
- `choices`: at least two, each a kebab-case `id`, a short `label`, what it `does`, its `effect` (`continue` launches the next run from the brief; `park` stops the queue working the item until a re-triage), and the `ruling` written into the issue body as a dated scope section when it is chosen. Write the ruling as the contract sentence the next run reads, such as "Downstream nodes may gate on head_matches too"; leave it empty when the choice changes no scope. The queue adds `other` itself, for an answer none of your choices covers; don't declare it.
- `if_unanswered`: whether the item waits, blocks other work, or goes stale as the base moves.
- `links`: the issue, and any pull request, report or run the decision rests on.

Declare `reason`: one line a maintainer can check.
