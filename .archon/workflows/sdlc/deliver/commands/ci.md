# Wait for CI and judge it

The pull request's review has passed. CI is the project's full validation: the implementer checked only what it changed. Mark the pull request ready, wait for its CI to conclude on the current head, judge what the result means, and act on it. No one watches this run; your structured answer and `$ARTIFACTS_DIR/ci.md` are all the next node reads.

The pull request is this branch's open pull request in the repository `origin` points at: find it with `gh pr list --repo <owner>/<repo> --head "$(git branch --show-current)" --state open`. Every `gh pr` command names that repository with `--repo <owner>/<repo>`: in a clone of a fork, gh otherwise resolves the upstream parent. When `ARCHON_SDLC_FORGE=forge`, use the forge seam instead (`archon forge pr.view`, `archon forge checks.state`, `archon forge pr.ready`, `archon forge pr.draft`, `archon forge checks.rerun`) with the qualified repository and number.

## Mark it ready, then wait

If the pull request is merged, declare `green`: there is nothing to mark. If it is closed without a merge, declare `other` and say so. Otherwise confirm the pull request's head is this checkout's `HEAD`: CI is never judged against a stale head. When the pull request's head is an ancestor of `HEAD` (a commit was made here but not pushed), push `HEAD` to the pull request's head branch by name (`git push <remote> HEAD:refs/heads/<branch>`; never force, never let git pick an upstream) and read the remote head back. If the push fails, or the two heads have diverged, declare `other` with the evidence.

Then confirm the pull request merges cleanly with its base (`gh pr view <number> --repo <owner>/<repo> --json mergeable,mergeStateStatus`; the forge may report the state as unknown for a moment after a push, so read it again until it is known). A pull request that conflicts with its base gets no CI run, so there is nothing to wait for: the conflict is this pull request's own problem. Find the conflicting paths (fetch the base and run `git merge-tree --write-tree <remote>/<base> HEAD`). Declare `pr_caused` without marking it ready, and write to `$ARTIFACTS_DIR/ci.md` the base branch, every conflicting path, and the instruction for the next round: merge the base branch into this branch with a normal merge commit, never a rebase, resolve every conflict keeping the intent of both sides, and check what the resolution touched.

Then take the pull request out of draft (`gh pr ready <number> --repo <owner>/<repo>`) and read it back to confirm it is no longer a draft: many repositories skip CI on draft pull requests, and marking it ready is what starts CI there. Then wait until every check on that head has concluded: `gh pr checks <number> --repo <owner>/<repo> --watch` blocks until they do. Right after a push the head may have no checks yet, so keep waiting for them however long it takes; there is no time limit. A repository with no CI configured at all (no active workflows) has no CI to be its validation, so you run the project's full validation yourself in this checkout, discovered from its own scripts and contributor docs, and wait for it to finish however long it takes: if your tool cuts a command off early, start it in the background, keep checking until it has finished, and read its result. Judge that result exactly as you would CI's below. CI that is configured but will not start without someone acting — the forge reports the run waiting on a maintainer's approval, or no workflow applies to this change — is `other`, with that evidence. A pending check is not green, and a check waiting on a maintainer's approval is not green either.

Do not cancel or otherwise change any check, and do not modify any file. The one exception is the single re-run below.

## Judge a red

For every failing check, gather the evidence before you claim a cause:

1. **Where it lives.** Read the failing job's logs (for GitHub, `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`; `gh pr checks` names the runs). Record the source file each failure points at: the failing test's file, or the file a compile, lint, or type error names. When a failure names no file, such as a job that never started or a runner that lost its connection, say so.
2. **The base.** Whether the same check fails on the base branch's latest concluded run. When it does, the base is red: say so explicitly in `ci.md` and the summary, and name that run, so whoever reads the outcome knows this pull request cannot go green until the base is fixed.
3. **The diff.** Whether any failing path is a file this pull request changed, or code its change makes reachable.

Then declare one state:

- `pr_caused` — this pull request's changes cause the failure, or the pull request conflicts with its base. A failure in a file the pull request changed is PR-caused whatever else is true. When you cannot tell, it is PR-caused: a correction round that finds nothing to fix costs less than shipping a defect.
- `other` — the failure exists without this pull request: the same check fails on the base, or the failure is the infrastructure's (a runner or network failure, a timeout on a path the change never touches), with the evidence that shows it.
- `green` — every check concluded and passed.

## Re-run a failure that is not this pull request's

When you judge a red `other` because it is a flake or an infrastructure failure, such as a runner or network failure, a timeout, or a race in a test, on a path this pull request does not change or make reachable, and the evidence above shows why it is not this pull request's, re-run only the failed jobs, once (for GitHub, `gh run rerun <run-id> --failed --repo <owner>/<repo>` for each run with a failed job). Never re-run a `pr_caused` failure, a failure the base shares (a re-run cannot fix the base), or anything a second time. Wait for the re-run to conclude as above, then judge every check again from the start: a green re-run is `green`, and the pull request stays ready. The re-run is part of this judgment, not a new round. Record its result as `rerun`: `green` or `red`, or `none` when you did not re-run.

## Record a defect outside this pull request

When a failure is a real defect outside this pull request, such as a test that fails on the base or races on a path this pull request never touches, record it as a discovery: reporting it now costs less than rediscovering it later. Write `$ARTIFACTS_DIR/discoveries/ci.json` as a JSON array of records with `title`, `claim`, `evidence` (the failing check, its log lines, the run, and the source file it points at), `relation` (`unrelated`), and `source_node` (`ci`). Write no file for no discovery, and never append to another node's file. The run's outcome relays it to the operator; do not file it anywhere yourself. A flake whose re-run went green is still a discovery when its log shows the defect.

## Act

- `green`: leave the pull request ready, and write the checks, the head they passed on, and any re-run with the failure it cleared to `$ARTIFACTS_DIR/ci.md`.
- `pr_caused` or `other`: first put the pull request back to draft (`gh pr ready <number> --repo <owner>/<repo> --undo`) and read it back to confirm it is a draft, so a red pull request never stays ready. Then write the failing checks, their log lines, the file each points at, and the cause with its evidence to `$ARTIFACTS_DIR/ci.md`. On `pr_caused` the next round's implementer fixes from that file, and review sees the correction again. When the failure is a test this pull request added that fails on its own cost, such as a timeout or a resource budget rather than a wrong assertion, the instruction may be to remove that test, or replace it with a focused test of the same behavior, instead of making it fit the budget. If a draft flip fails, say so in the summary; the state stays what CI showed.

## Declare

First copy the `$ARTIFACTS_DIR/ci.md` you wrote to `$ARTIFACTS_DIR/ci-round-N.md`, where `N` is the highest `N` among `$ARTIFACTS_DIR/review/report-round-N.md` (the review round this CI follows). `ci.md` stays the latest result; the round copy is history the next round never overwrites.

- `state` — `green`, `pr_caused`, or `other`.
- `rerun` — `none`, `green`, or `red`: whether you re-ran failed jobs, and how the re-run concluded.
- `summary` — two to four sentences: the checks and their conclusions, the cause with the log lines, runs, and commits that show it, any re-run and its result, a red base with its run, and the pull request's draft state when you finished.
