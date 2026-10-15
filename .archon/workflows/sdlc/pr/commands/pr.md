# Prepare the Pull Request

Prepare a clear, reviewer-friendly pull request for the committed work on the current branch. You never modify source files, and you never push, create, edit, or comment on the pull request yourself: your one write is the body file below. The node that follows pushes the branch and performs the one public write, through whichever forge source the run selected. You do not merge the base: a conflict with it is found by CI and resolved by the implementer.

Draft mode: **$INPUTS.draft** — `true` opens as a draft; anything else, ready for review. A pull request that already exists keeps the draft state its author gave it.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

Record `HEAD_BRANCH=$(git branch --show-current)` before doing anything else; an empty value is a hard failure, as is a `HEAD` with no commits. Resolve the repository the pull request opens against from the checkout's remotes (`git remote -v`): the repository this work is proposed to, which in a fork setup is the upstream the fork was made from, not the fork. Whatever the remotes are named, declare its canonical forge identity as `host` plus `path` (`owner/repo`), with transport syntax, credentials, and a trailing `.git` stripped; GitHub's HTTPS, `git@github.com:...`, and `ssh://git@ssh.github.com/...` forms all declare host `github.com`. Remotes that do not identify one repository are a hard failure. Never persist or print a credential-bearing raw remote.

Determine the base branch from evidence, in order: the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default); an existing pull request for this exact branch. Never assume `main`. Use the same resolved base for every diff.

When this run continues an existing pull request — the caller resolved it (`$INPUTS.pull_request`; empty or `null` when it named none), the run's context names its number, or the run was launched onto it — record that number and the qualified head repository and head branch it belongs to. `HEAD` must descend from that pull request's current head revision; if it does not, stop and report rather than prepare a replacement. If the head lives in a fork and the author did not allow maintainer edits, this run cannot publish to it: stop and report.

You do not look up whether this branch already has a pull request. The publishing node does that deterministically and never opens a second one.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. If intended work sits uncommitted, commit it first following the repository's conventions — staged by name, one coherent outcome per commit, human-sounding message, no AI attribution. Never sweep unrelated changes; if intended and unrelated changes cannot be separated safely, stop and say so.
- Read the complete merge-base diff — not just the file list — and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- When the plan this work delivers lists contract additions, flag each one in the body as a contract addition: what it adds to the shipped surface, and why every existing value keeps its meaning, so the reviewer can check that claim.
- Title: concise, human, the meaningful outcome — never an implementation inventory.
- Link the issue with a non-closing reference (`Refs #N`), never a closing keyword, even where the template offers a `Closes #` line. A pull request closes its issue only when a review's contract coverage marks the required outcome and every acceptance item met, and no review has judged this work yet; delivery applies the closing keyword after its final review. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- When this run continues an existing pull request, the body is its current description brought up to date for this round: read it with `gh pr view <number> --repo <owner>/<repo> --json body`, naming the repository because `gh` resolves it from the working directory's git remotes, and `$ARTIFACTS_DIR` is not a checkout. Keep a person's edits and every claim that is still true; change what this round falsified or added.
- Write the complete body to `$ARTIFACTS_DIR/pr-body.md` — never inside the repository — with your file-writing tool or a quoted heredoc, not by redirecting a command's output: a pipeline whose first command fails can leave the file empty and still exit 0. Then read the file back. It must hold the whole body, with the template's required sections. If you cannot produce that body, stop and report why; never declare the pointer below for a file you have not read back.

## 4. Declare the target

- `repo`: `{ "host", "path" }` of the repository the pull request opens against.
- `head_repo`: the same shape for the repository the head branch lives in — `repo` itself unless the head is in a fork.
- `head`: the head branch name, unqualified: the recorded branch, or the existing pull request's head branch.
- `base`: the resolved base branch.
- `existing`: the number of the pull request this run continues, or `null`.
- `title`: the title you wrote.
- `body`: `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "pr-body.md"}`, copied exactly.
- `summary`: the target in one sentence.

Declare no credential and no raw remote URL.
