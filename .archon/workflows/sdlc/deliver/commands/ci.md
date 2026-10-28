# Wait for CI and judge it

The pull request's review has passed. CI is the project's full validation: the implementer checked only what it changed. Mark the pull request ready, wait for its CI to conclude on the current head, judge what the result means, and act on it. No one watches this run; your structured answer and `$ARTIFACTS_DIR/ci.md` are all the next node reads.

The pull request is the one this round published: `$INPUTS.pr`. That record names its repository (`repo.host`, `repo.path`), `number`, `head` branch and `base`; act on exactly that pull request, never one found from the checkout's remotes or branch. Every forge read and write goes through the source this run selected, `$INPUTS.source`:

- **`forge`:** the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, run as `<argv...> forge <op> --json --data '<request>'`. With `<ref>` = `{"repo":{"host":…,"path":…},"number":…}` from the record: `pr.view` takes `{"selector":{"kind":"number","ref":<ref>}}`; `pr.ready`, `pr.draft` and `checks.state` take `{"ref":<ref>}`; `checks.rerun` takes `{"ref":<ref>,"revision":…,"units":[…]}`. A `checks.state` answer carries the `revision` it evaluated, each unit's conclusion, and a `summary` whose `counts` give the number of units in each state and whose `state` (`none`, `pending`, `green`, `red`, `gated` or `unknown`) is the worst unit's: one red unit makes it `red` while others are still `pending`. A failed operation is the answer: report it, and never repeat it through `gh`.
- **`gh`:** the GitHub CLI, every command naming the repository with `--repo <host>/<path>`: in a clone of a fork, gh otherwise resolves the upstream parent.

## Mark it ready, then wait

If the pull request is merged, declare `green`: there is nothing to mark. If it is closed without a merge, declare `other` and say so. Otherwise confirm the pull request's head is this checkout's `HEAD`: CI is never judged against a stale head. When the pull request's head is an ancestor of `HEAD` (a commit was made here but not pushed), push `HEAD` to the pull request's head branch by name (`git push <remote> HEAD:refs/heads/<branch>`; never force, never let git pick an upstream) and read the remote head back. If the push fails, or the two heads have diverged, declare `other` with the evidence. When the pull request's head carries commits this checkout's `HEAD` does not, someone pushed after this round's review and no review covered them: do not mark it ready, put it back to draft if it is ready, and declare `other` naming those commits. A continuation delivery reviews them before the pull request counts as ready again.

Then confirm the pull request merges cleanly with its base: fetch the base from the remote whose URL is the record's repository (`git remote -v`; it need not be named `origin`) and run `git merge-tree --write-tree <remote>/<base> HEAD`, which exits 1 on a conflict and names the conflicting paths. A pull request that conflicts with its base gets no CI run, so there is nothing to wait for: the conflict is this pull request's own problem. Declare `pr_caused` without marking it ready, and write to `$ARTIFACTS_DIR/ci.md` the base branch, every conflicting path, and the instruction for the next round: merge the base branch into this branch with a normal merge commit, never a rebase, resolve every conflict keeping the intent of both sides, and check what the resolution touched.

Then take the pull request out of draft (`pr.ready`, or `gh pr ready <number> --repo <host>/<path>`) and read it back to confirm it is no longer a draft: many repositories skip CI on draft pull requests, and marking it ready is what starts CI there. Then wait until every check on that head has concluded.

Your final message is your answer, and ending your turn is final: this node completes the moment you stop, and nothing resumes it. Never end your turn while a check is pending, and never end it to wait for a notification. A background job's notification cannot reach you after you answer, and the job is killed with the node. So wait in the foreground, with commands that each finish within your tool's time limit, and repeat them until the checks conclude. Answering "CI not judged" because the wait was long, a watch was cut off, or a job is still running is wrong: keep waiting.

- **`gh`:** `gh pr checks <number> --repo <host>/<path> --watch` blocks until the checks conclude, but your tool may cut it off first. Run it in the foreground; when it is cut off or returns with checks still pending, run it again. Don't wait with a bare `sleep` between reads: some agent tools refuse it, and `--watch` already waits for you. Repeat until no check is pending.
- **`forge`:** read `checks.state` again, with a pause between reads, until its `revision` is the pushed head commit, its `summary.state` is not `none`, and its `summary.counts.pending` is 0. Bound each command (a short loop of reads with pauses that ends within your tool's time limit) and repeat the command until then.

Right after a push the head may have no checks yet (`none`), so keep waiting for them however long it takes; there is no time limit. `none` alone does not say whether checks are coming: judge that from the repository's CI configuration (on GitHub, the workflows under `.github/workflows` and the events and paths that trigger them). When none would run for this pull request, stop waiting: it is one of the two cases below. A repository with no CI configured at all (no active workflows) has no CI to be its validation, so you run the project's full validation yourself in this checkout, discovered from its own scripts and contributor docs, and wait for it to finish however long it takes: if your tool cuts a command off early, you may start it in the background, but then poll that job in the foreground, with commands that each finish within your tool's time limit, until it has finished, and read its result; never end your turn while it runs. Judge that result exactly as you would CI's below. CI that is configured but will not start without someone acting — the forge reports the run waiting on a maintainer's approval (`approvalPending: true`, or a `gated` state), or no workflow applies to this change — is `other`, with that evidence. A pending check is not green, and a check waiting on a maintainer's approval is not green either.

Do not cancel or otherwise change any check, and do not modify any file. The one exception is the single re-run below.

## Judge a red

For every failing check, gather the evidence before you claim a cause:

1. **Where it lives.** Read the failing job's logs with the tools the run has (for GitHub, `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`, which authenticates with `GH_TOKEN`; the checks name the runs). Record the source file each failure points at: the failing test's file, or the file a compile, lint, or type error names. When a failure names no file, such as a job that never started or a runner that lost its connection, say so.
2. **The base.** Whether the same check fails on the base branch's latest concluded run. When it does, the base is red: say so explicitly in `ci.md` and the summary, and name that run, so whoever reads the outcome knows this pull request cannot go green until the base is fixed.
3. **The diff.** Whether any failing path is a file this pull request changed, or code its change makes reachable.

Then declare one state:

- `pr_caused` — this pull request's changes cause the failure, or the pull request conflicts with its base. A failure in a file the pull request changed is PR-caused whatever else is true. When you cannot tell, it is PR-caused: a correction round that finds nothing to fix costs less than shipping a defect.
- `other` — the failure exists without this pull request: the same check fails on the base, or the failure is the infrastructure's (a runner or network failure, a timeout on a path the change never touches), with the evidence that shows it.
- `green` — every check concluded and passed.

## Re-run a failure that is not this pull request's

When you judge a red `other` because it is a flake or an infrastructure failure, such as a runner or network failure, a timeout, or a race in a test, on a path this pull request does not change or make reachable, and the evidence above shows why it is not this pull request's, re-run only the failed jobs, once (on `forge`, `checks.rerun` with the latest `checks.state`'s `revision` and its failed units that carry a non-null `rerun`; on `gh`, `gh run rerun <run-id> --failed --repo <host>/<path>` for each run with a failed job). A re-run of failed jobs re-runs every failed job in that run, so re-run only when every failing check is such a flake or infrastructure failure: never when any failure is `pr_caused` or shared with the base (a re-run cannot fix the base), and never a second time. Wait for the re-run to conclude as above (on `forge`, retain the run IDs and newer attempts returned in `checks.rerun`'s `units`; a read right after the request can still show old failures. Wait until `checks.state` reports the requested revision and each rerun group at that returned attempt or newer, then until `summary.counts.pending` is 0. Match groups by `rerun.id` and `rerun.attempt`, since check-unit IDs can change between attempts. A newer attempt may already be terminal on the first read: judge it immediately without requiring an observation of `pending`), then judge every check again from the start: a green re-run is `green`, and the pull request stays ready. The re-run is part of this judgment, not a new round. Record its result as `rerun`: `green` or `red`, or `none` when you did not re-run.

## Record a defect outside this pull request

When a failure is a real defect outside this pull request, such as a test that fails on the base or races on a path this pull request never touches, record it as a discovery: reporting it now costs less than rediscovering it later. Write `$ARTIFACTS_DIR/discoveries/ci.json` as a JSON array of records with `title`, `claim`, `evidence` (the failing check, its log lines, the run, and the source file it points at), `relation` (`unrelated`), and `source_node` (`ci`). Write no file for no discovery, and never append to another node's file. The run's outcome relays it to the operator; do not file it anywhere yourself. A flake whose re-run went green is still a discovery when its log shows the defect.

## Act

Before declaring `green`, read the pull request's head again; when it is no longer this checkout's `HEAD`, the checks you judged are not on it: answer as for a head that carries unreviewed commits.

- `green`: leave the pull request ready, and write the checks, the head they passed on, and any re-run with the failure it cleared to `$ARTIFACTS_DIR/ci.md`.
- `pr_caused` or `other`: first put the pull request back to draft (`pr.draft`, or `gh pr ready <number> --repo <host>/<path> --undo`) and read it back to confirm it is a draft, so a red pull request never stays ready. Then write the failing checks, their log lines, the file each points at, and the cause with its evidence to `$ARTIFACTS_DIR/ci.md`. On `pr_caused` the next round's implementer fixes from that file, and review sees the correction again. When the failure is a test this pull request added that fails on its own cost, such as a timeout or a resource budget rather than a wrong assertion, the instruction may be to remove that test, or replace it with a focused test of the same behavior, instead of making it fit the budget. If a draft flip fails, say so in the summary; the state stays what CI showed.

## Declare

First copy the `$ARTIFACTS_DIR/ci.md` you wrote to `$ARTIFACTS_DIR/ci-round-N.md`, where `N` is the highest `N` among `$ARTIFACTS_DIR/review/report-round-N.md` (the review round this CI follows). `ci.md` stays the latest result; the round copy is history the next round never overwrites.

- `state` — `green`, `pr_caused`, or `other`.
- `rerun` — `none`, `green`, or `red`: whether you re-ran failed jobs, and how the re-run concluded.
- `summary` — two to four sentences: the checks and their conclusions, the cause with the log lines, runs, and commits that show it, any re-run and its result, a red base with its run, and the pull request's draft state when you finished.
