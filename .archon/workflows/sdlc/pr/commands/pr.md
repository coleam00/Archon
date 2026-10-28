# Prepare the Pull Request

Prepare a clear, reviewer-friendly pull request for the committed work on the current branch. You never modify source files, and you never push, create, edit, or comment on the pull request yourself: your only writes are the body file and the description file below. The node that follows owns the branch push and PR writes, and verifies the description edit through whichever forge source the run selected. You do not merge the base: a conflict with it is found by CI and resolved by the implementer.

Draft mode: **$INPUTS.draft** — `true` opens as a draft; anything else, ready for review. A pull request that already exists keeps the draft state its author gave it.

Description section: **$INPUTS.publish_description** — `true` lets this run publish content it prepared for the pull request's description; anything else, it prepares none.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

Record `HEAD_BRANCH=$(git branch --show-current)` before doing anything else; an empty value is a hard failure, as is a `HEAD` with no commits. Resolve the repository the pull request opens against from the checkout's remotes (`git remote -v`): the repository this work is proposed to, which in a fork setup is the upstream the fork was made from, not the fork. Whatever the remotes are named, declare its canonical forge identity as `host` plus `path` (`owner/repo`), with transport syntax, credentials, and a trailing `.git` stripped; GitHub's HTTPS, `git@github.com:...`, and `ssh://git@ssh.github.com/...` forms all declare host `github.com`. Remotes that do not identify one repository are a hard failure. Never persist or print a credential-bearing raw remote.

Determine the base branch from evidence, in order: the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default); an existing pull request for this exact branch. Never assume `main`. Use the same resolved base for every diff.

When this run continues an existing pull request — the caller resolved it (`$INPUTS.pull_request`; empty or `null` when it named none), the run's context names its number, or the run was launched onto it — record that number and the qualified head repository and head branch it belongs to. Read that pull request through the source this run selected, `$INPUTS.source`: with `forge`, `<argv...> forge pr.view --json --data '{"selector":{"kind":"number","ref":{"repo":{"host":…,"path":…},"number":…}}}'`, where `<argv...>` is the JSON string array in `$ARCHON_CLI_COMMAND`; with `gh`, `gh pr view <number> --repo <host>/<owner>/<repo> --json headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify`. Either way name the repository: `gh` otherwise resolves it from the working directory's git remotes. A failed read is the answer: report it, and never repeat it through `gh`. `HEAD` must descend from that pull request's current head revision; if it does not, stop and report rather than prepare a replacement. If the head lives in a fork and the author did not allow maintainer edits, this run cannot publish to it: stop and report.

You do not look up whether this branch already has a pull request. The publishing node does that deterministically and never opens a second one.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. If intended work sits uncommitted, commit it first following the repository's conventions — staged by name, one coherent outcome per commit, human-sounding message, no AI attribution. Never sweep unrelated changes; if intended and unrelated changes cannot be separated safely, stop and say so.
- Read the complete merge-base diff — not just the file list — and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- When the plan this work delivers lists contract additions, flag each one in the body as a contract addition: what it adds to the shipped surface, and why every existing value keeps its meaning, so the reviewer can check that claim.
- Title: concise, human, the meaningful outcome — never an implementation inventory.
- Link the issue with a non-closing reference (`Refs #N`), never a closing keyword, even where the template offers a `Closes #` line: no review has judged this work yet. Delivery picks the final keyword after its final review, from the review's contract coverage and the issue's dated rulings. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- Write no body only when `existing` is a number and either the caller named a pull request or selected no branch. A named pull request means `$INPUTS.pull_request` is neither empty nor `null`; no selected branch means `$INPUTS.branch` is empty. In that case, the description stays as its author left it, apart from the section the last bullet below prepares, and inside delivery `update-pr-body` brings it up to date once the rounds end. Skip the rest of this section except the title and the description file below.
- Otherwise, write the complete body to `$ARTIFACTS_DIR/pr-body.md` — never inside the repository — with your file-writing tool or a quoted heredoc, not by redirecting a command's output: a pipeline whose first command fails can leave the file empty and still exit 0. When the caller selected a branch without naming a pull request, write the body even if `existing` is a number: publish may need it to open a new pull request from that branch. It is published only when a new pull request opens. Then read the file back. It must hold the whole body, with the template's required sections. If you cannot produce that body, stop and report why; never declare the pointer below for a file you have not read back.
- When the description section is `true` and the run's artifacts (normally `implementation.md`) carry content the work requires in the pull request's description — evidence, measurements, results — write that content, complete and not summarized, to `$ARTIFACTS_DIR/pr-description.md` with your file-writing tool, then read it back. Never put it in `pr-body.md` as well: the publishing node places it in its own marked section of the description, on a pull request this run opens or continues, and leaves the rest of the description as it is. Raw delivery markers are reserved; put literal marker examples in Markdown code. Otherwise write no such file.

## 4. Declare the target

- `repo`: `{ "host", "path" }` of the repository the pull request opens against.
- `head_repo`: the same shape for the repository the head branch lives in — `repo` itself unless the head is in a fork.
- `head`: the head branch name, unqualified: the recorded branch, or the existing pull request's head branch.
- `base`: the resolved base branch.
- `existing`: the number of the pull request found for this work, or `null`. When the caller selected a branch without naming a pull request, publish reuses only an open pull request with that head.
- `title`: the title you wrote.
- `body`: `null` only when `existing` is a number and either the caller named a pull request or selected no branch, as in section 3; otherwise `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "pr-body.md"}`, copied exactly.
- `description`: `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "pr-description.md"}`, copied exactly, when you wrote and read back that file; otherwise `null`.
- `summary`: the target in one sentence.

Before declaring, check every required field, including `description`. Writing
`pr-description.md` without its non-null pointer does not publish anything. For a
continued PR, `body: null` skips only the opening body; it never skips required
description content. When the work requires live publication evidence, include
the tested commit and results in that content. The publisher performs the live
write and read-back before review judges it.

Declare no credential and no raw remote URL.
