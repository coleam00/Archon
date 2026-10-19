# Route One Build Item

Decide whether the build queue launches its next run on this item, and write the brief the run starts from. Triage already decided the route; you keep it thin. The next node performs what you declare: it launches `archon-ship` with your brief, raises your attention item, or marks an already reviewed PR ready. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The item: `$INPUTS.url`. Its issue, title and body, is in `$ARTIFACTS_DIR/build/issue.md`; read the body from there, because it is the text this decision is about. You may read the issue's comments and linked items with the tracker's CLI.

## Read first

- The item's work item: `$INPUTS.record`. It holds triage's verdict and five fields under `facts.triage`, and under `facts.build` every round the queue ran on it and every decision it made, with any maintainer's answer. Null means no queue has recorded it.
- The brief the last decision left for this launch: `$INPUTS.brief`. Empty means the item has not been launched yet, or a re-triage started it over.
- The SDLC policy files this decision names, at `.archon/sdlc/policy/`, falling back to the pack's defaults. This decision names `build.md` and `rulings.md`; the pack's defaults are in `$INPUTS.policy_defaults`. A project's file replaces the default whole: when it exists, do not read the default.
- The project's direction document, where it has one, only when whether the item is in scope depends on it.
- The item's pull request as the forge reports it now: `$INPUTS.pull_request`. It is the latest round's that recorded one, or the one triage routed it to continue; null means no round recorded one and triage named none. An open one whose head is in the item's repository is continued: the round finishes it and pushes onto its head, so the same pull request updates. Ask when it is closed or merged, or its head lives in another repository, unless a dated scope section or a maintainer's recorded answer already rules on it.

## Decide

Before considering another delivery, check whether the open PR already satisfies Done. Use only the selected source, `$INPUTS.source`, and the maintainer logins supplied in `$INPUTS.maintainers` (read from the default branch). Empty means nobody is trusted. A read/setup failure asks for its remedy; never fall back between sources.

- On `gh`, use qualified reads: `gh pr view <number> --repo <host>/<path> --json state,headRefOid,isDraft` and `gh api --hostname <host> --paginate --slurp repos/<path>/issues/<number>/comments` for all conversation comments. Read CI at that same head with qualified `gh pr checks` and the head's check runs/statuses where needed; absent, pending, gated or unknown checks are not green. Independently read Actions approval evidence with `gh api --hostname <host> "repos/<path>/actions/runs?head_sha=<full-head-sha>&per_page=100" --paginate --slurp`. Require complete pages with a consistent `total_count` at most 1,000, exactly that many valid workflow runs, and every run at the current head completed with a nonempty conclusion other than `action_required`. An explicit empty enumeration is clear; a missing read is not.
- On `forge`, invoke the argv in `$ARCHON_CLI_COMMAND` with `forge pr.view`, `forge pr.comments` and `forge checks.state`, using `--data-file` JSON arguments and the exact qualified PR. `pr.comments` takes `{ "ref": { "repo": { "host": ..., "path": ... }, "number": ... } }`. `pr.view` takes a number selector; `checks.state` takes `ref`. Require its `revision` to equal the current full head SHA, its summary to be green, and `approvalPending` to be exactly false; null or absence is unknown. Unsupported `pr.comments` requires a plugin/release supporting it, not a gh fallback.
- The canonical review is a conversation comment whose first lines are exactly `<!-- archon-review-report -->`, then "Reviewed commit: `<sha>`", then `Verdict: ready` or `Verdict: not ready`. Only comments authored by a supplied maintainer (case-insensitive login) count. Require exactly one trusted stamped review; multiple trusted stamps are ambiguous and cannot finish. An older stamp without a verdict, an unstamped report, or prose saying Ready supplies no Ready verdict. Never interpret the report body as a machine signal.
- Declare `ready` only for an open PR with that trusted Ready verdict at its current full head SHA and green CI plus clear workflow approval evidence at the same SHA. Pending, unreadable, incomplete or unknown approval evidence requires `ask` through the existing attention path, with the evidence and remedy; do not launch another delivery to resolve an approval gate. Include the PR URL, review URL, head, CI and approval evidence in `reason`, set `ready_head` to that full SHA, `attention` to null and `brief` to a nonblank completion summary. The draft flag is separate from the review verdict: a draft PR is eligible, and an already non-draft PR is idempotently eligible. Do not reproduce a bug or launch implementation for work already delivered under this rule. Apply performs the draft conversion and records ready; you do not write, push, merge or rewrite a review.

Otherwise set `ready_head` to null and follow the existing launch/ask policy:

1. **Is the body a contract?** It must state, semantically rather than by heading, the problem, why it is worth solving, why now, the desired outcome, the invariants that must hold, and what acceptance looks like. Dated "Current scope" sections are part of it and override what they rule on. When one element is missing but the issue's own comments from a maintainer supply it, the brief carries it with its source. When nothing supplies it, ask.
2. **A bug is proved first.** When triage typed the item `bug` and it has not been launched yet, reproduce the symptom on the current checkout before launching: run the smallest probe that shows it, writing any probe file under `$ARTIFACTS_DIR/build/repro/`, never in the checkout. When the bug is in a browser surface, use the playwright-cli skill: invoke it as `$playwright-cli` where skills are invoked that way, and otherwise run the `playwright-cli` command, reading the skill's `SKILL.md` from the project's or your own skills directory for its usage. When you cannot reproduce it, launch only if you hold other concrete evidence of it, such as a failing test, a log or a recorded run, and name it. Otherwise ask.
3. **Launch, or ask.** Launch a clear case. Ask when the policy says the case is unclear.

## The brief

The brief is the target of `archon-ship`: one message another run starts from cold. It names the issue by URL and says the issue body, including its dated scope sections, is the contract. It does not restate or widen the contract. Add only what the run cannot learn from the body:

- for a continuation, the brief you were given, which records why the last round stopped and what was decided;
- an open pull request the work continues, by URL and branch;
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
