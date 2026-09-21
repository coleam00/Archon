# Open the Pull Request

Create a clear, reviewer-friendly pull request for the committed work on the current branch. The PR itself is the artifact — produce no separate report. You never modify source files; your writes are git push and the PR. Every fact belongs in the PR title and body.

Draft mode: **$INPUTS.draft** — `true` means open as a draft; anything else, ready for review.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

Record `HEAD_BRANCH=$(git branch --show-current)` before doing anything public; an empty value is a hard failure. Read the origin remote once and resolve its canonical forge identity as `REPO_HOST` plus `REPO_PATH` (`owner/repo`). Strip transport syntax, credentials, and a trailing `.git`; normalize GitHub's ordinary HTTPS, `git@github.com:...`, and `ssh://git@ssh.github.com/...` forms to `REPO_HOST=github.com`. An origin that does not identify one repository is a hard failure. Never persist or print a credential-bearing raw remote. Use this same resolved `REPO_PATH` for every `gh --repo` argument.

Determine the base branch from evidence, in order: an existing PR for that exact branch in `REPO_PATH` (read it back by explicit number); the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default). Never assume `main`. Use the same resolved base for every diff and command.

When an open PR already exists for this work, it is the pull request: never create another. Find it by `HEAD_BRANCH` for a same-repository branch. For a pull request from a fork the run sits on a review branch at the PR's head, so find it by the number the run's context names and confirm `HEAD` descends from its `headRefOid`. Read `isCrossRepository`, `maintainerCanModify`, `headRepositoryOwner`, `headRepository`, `headRefName`, and `headRefOid` once and record them; the descent check above and the read-back in step 5 both need that SHA. Push to it in step 4, read that number back in step 5, and leave its draft state as you found it rather than applying `$INPUTS.draft`. If the head lives in a fork and `maintainerCanModify` is false, this run cannot publish to it: stop and report, and do not open a replacement.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. If intended work sits uncommitted, commit it first following the repository's conventions — staged by name, one coherent outcome per commit, human-sounding message, no AI attribution. Never sweep unrelated changes; if intended and unrelated changes cannot be separated safely, stop and say so.
- Read the complete merge-base diff — not just the file list — and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- Title: concise, human, the meaningful outcome — never an implementation inventory.
- Link the issue with `Closes #N` only when the PR fully resolves it; `Relates to #N` otherwise. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- Check whether a gate passed red: read every `$ARTIFACTS_DIR/nodes/*.meta.json` whose `outputType` is `green-gate`, then the `.md` file beside it, which holds that gate's JSON result. Any with a non-empty `red_cause` means this branch is being delivered while a project check is red. Add a short, plainly-titled section near the top of the body giving each such gate's `stage`, `red_cause`, and `summary`, and say that the PR's own CI is the check that still decides. A reviewer must not have to discover this from a red badge.
- If you write the body to a file, put it under `$ARTIFACTS_DIR/` — never inside the repository.

## 4. Push and create

Push the recorded branch with upstream tracking (`git push -u origin "$HEAD_BRANCH"`). For an existing fork PR whose author allowed maintainer edits, push to the fork instead, by explicit URL and ref: `git push "https://github.com/<headRepositoryOwner>/<headRepository>.git" "HEAD:refs/heads/<headRefName>"`. If the push is rejected or the remote diverged, stop and report — never rebase or force-push here. Unless step 1 found an existing PR, create the PR against the resolved base, honoring draft mode, and pass `--head "$HEAD_BRANCH"` explicitly. Pin every PR command to the recorded origin repository with `--repo "$REPO_PATH"` — in a clone of a fork, the CLI's default resolution targets the fork's upstream parent, publishing the diff against a repository the author never chose.

## 5. Verify by reading back

Read the created or existing PR back from GitHub by its explicit number and `--repo "$REPO_PATH"`: confirm the repository identity, number, URL, title, base, head, and draft state match what you intended. The read-back head must equal `HEAD_BRANCH`, or for a fork PR the recorded `headRefName` with its head SHA equal to what you pushed; a repository or branch mismatch is a hard failure. Not done until the read-back agrees.

Write `$ARTIFACTS_DIR/pr-action.md` with `REPO_HOST`, `REPO_PATH`, the recorded branch, the explicit push target, the PR number, and the create/read-back results. Do not put credentials or the raw origin URL in it. This is the durable action evidence; the node's typed output preserves the verified PR identity.

Return the verified record through the node's structured output, with exactly these fields: `repo` (`{ "host": REPO_HOST, "path": REPO_PATH }`), `number` (integer), `url`, `head`, `base`, and `is_draft` (boolean). This record is the run's authority for every later push, PR edit, comment, ready flip, and inbound forge event.
