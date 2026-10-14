# Wait for CI and judge it

The pull request's review has passed. CI is the project's full validation: the implementer checked only what it changed. Mark the pull request ready, wait for its CI to conclude on the current head, judge what the result means, and act on it. No one watches this run; your structured answer and `$ARTIFACTS_DIR/ci.md` are all the next node reads.

The pull request is this branch's open pull request in the repository `origin` points at: find it with `gh pr list --repo <owner>/<repo> --head "$(git branch --show-current)" --state open`. Every `gh pr` command names that repository with `--repo <owner>/<repo>`: in a clone of a fork, gh otherwise resolves the upstream parent. When `ARCHON_SDLC_FORGE=forge`, use the forge seam instead (`archon forge pr.view`, `archon forge checks.state`, `archon forge pr.ready`, `archon forge pr.draft`) with the qualified repository and number.

## Mark it ready, then wait

If the pull request is merged, declare `green`: there is nothing to mark. If it is closed without a merge, declare `other` and say so. Otherwise confirm the pull request's head is this checkout's `HEAD`: CI is never judged against a stale head. When the pull request's head is an ancestor of `HEAD` (a commit was made here but not pushed), push `HEAD` to the pull request's head branch by name (`git push <remote> HEAD:refs/heads/<branch>`; never force, never let git pick an upstream) and read the remote head back. If the push fails, or the two heads have diverged, declare `other` with the evidence.

Then confirm the pull request merges cleanly with its base (`gh pr view <number> --repo <owner>/<repo> --json mergeable,mergeStateStatus`; the forge may report the state as unknown for a moment after a push, so read it again until it is known). A pull request that conflicts with its base gets no CI run, so there is nothing to wait for: the conflict is this pull request's own problem. Find the conflicting paths (fetch the base and run `git merge-tree --write-tree <remote>/<base> HEAD`). Declare `pr_caused` without marking it ready, and write to `$ARTIFACTS_DIR/ci.md` the base branch, every conflicting path, and the instruction for the next round: merge the base branch into this branch with a normal merge commit, never a rebase, resolve every conflict keeping the intent of both sides, and check what the resolution touched.

Then take the pull request out of draft (`gh pr ready <number> --repo <owner>/<repo>`) and read it back to confirm it is no longer a draft: many repositories skip CI on draft pull requests, and marking it ready is what starts CI there. Then wait until every check on that head has concluded: `gh pr checks <number> --repo <owner>/<repo> --watch` blocks until they do. Right after a push the head may have no checks yet, so keep waiting for them however long it takes; there is no time limit. A repository with no CI configured at all (no active workflows) has no CI to be its validation, so you run the project's full validation yourself in this checkout, discovered from its own scripts and contributor docs, and wait for it to finish however long it takes: if your tool cuts a command off early, start it in the background, keep checking until it has finished, and read its result. Judge that result exactly as you would CI's below. CI that is configured but will not start without someone acting — the forge reports the run waiting on a maintainer's approval, or no workflow applies to this change — is `other`, with that evidence. A pending check is not green, and a check waiting on a maintainer's approval is not green either.

Do not re-run, cancel, or otherwise change any check, and do not modify any file.

## Judge a red

For every failing check, gather the evidence before you claim a cause:

1. **Where it lives.** Read the failing job's logs (for GitHub, `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs`; `gh pr checks` names the runs). Record the source file each failure points at: the failing test's file, or the file a compile, lint, or type error names. When a failure names no file, such as a job that never started or a runner that lost its connection, say so.
2. **The base.** Whether the same check fails on the base branch's latest concluded run.
3. **The diff.** Whether any failing path is a file this pull request changed, or code its change makes reachable.

Then declare one state:

- `pr_caused` — this pull request's changes cause the failure, or the pull request conflicts with its base. A failure in a file the pull request changed is PR-caused whatever else is true. When you cannot tell, it is PR-caused: a correction round that finds nothing to fix costs less than shipping a defect.
- `other` — the failure exists without this pull request: the same check fails on the base, or the failure is the infrastructure's (a runner or network failure, a timeout on a path the change never touches), with the evidence that shows it.
- `green` — every check concluded and passed.

## Act

- `green`: leave the pull request ready, and write the checks and the head they passed on to `$ARTIFACTS_DIR/ci.md`.
- `pr_caused` or `other`: first put the pull request back to draft (`gh pr ready <number> --repo <owner>/<repo> --undo`) and read it back to confirm it is a draft, so a red pull request never stays ready. Then write the failing checks, their log lines, the file each points at, and the cause with its evidence to `$ARTIFACTS_DIR/ci.md`. On `pr_caused` the next round's implementer fixes from that file, and review sees the correction again. When the failure is a test this pull request added that fails on its own cost, such as a timeout or a resource budget rather than a wrong assertion, the instruction may be to remove that test, or replace it with a focused test of the same behavior, instead of making it fit the budget. If a draft flip fails, say so in the summary; the state stays what CI showed.

## Declare

First copy the `$ARTIFACTS_DIR/ci.md` you wrote to `$ARTIFACTS_DIR/ci-round-N.md`, where `N` is the highest `N` among `$ARTIFACTS_DIR/review/report-round-N.md` (the review round this CI follows). `ci.md` stays the latest result; the round copy is history the next round never overwrites.

- `state` — `green`, `pr_caused`, or `other`.
- `summary` — two to four sentences: the checks and their conclusions, the cause with the log lines, runs, and commits that show it, and the pull request's draft state when you finished.
