# Open the Pull Request

Create a clear, reviewer-friendly pull request for the committed work on the current branch. The PR itself is the artifact; produce no separate report. You never modify source files; you prepare content for the following deterministic publisher. Every fact belongs in the PR title and body.

Draft mode: **$INPUTS.draft**; `true` means open as a draft; anything else, ready for review.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

Record `HEAD_BRANCH` with `git branch --show-current`; an empty branch is a hard failure. Read the repository's forge CLI to establish the exact current branch's existing PR, when present. Use `archon forge resolve --json` for qualified repository identity; never persist raw remote URLs. The publisher pins origin explicitly, including in fork checkouts.

If `HEAD_BRANCH` is a synthetic fork-review branch (`pr-<number>-review`, optionally prefixed `archon/`), stop before any public write. This workflow does not publish from that checkout to the fork or create a substitute PR. Report the PR number and ask the operator to arrange a writable checkout of its actual head.

Check for an open PR for this exact branch in the qualified repository. If one exists, read back its number, base, and state; reuse it and its base throughout this run. Refuse ambiguous matches. A repair must not create another PR.

Otherwise determine the base branch from evidence, in order: explicit run authorization or a base named in the run context; the run's base (`$BASE_BRANCH`); the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default). Never assume `main`. Keep that logical branch name for publication; use its qualified `refs/remotes/origin/<base>` commit for Git comparisons, fetching the exact origin branch when needed. A missing authorized base is a failure, not permission to choose another.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. If intended work remains uncommitted or cannot be separated from unrelated changes, stop and report what needs to be committed before publication.
- Read the complete merge-base diff; not just the file list; and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- Title: concise, human, the meaningful outcome; never an implementation inventory.
- Link the issue with `Closes #N` only when the PR fully resolves it; `Relates to #N` otherwise. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- If `$ARTIFACTS_DIR/red-causes.json` exists, this branch is being delivered while a project check is red. Add a short, plainly-titled section near the top of the body giving each record's cause and the evidence for it from `implementation.md`, and say that the PR's own CI is the check that still decides. A reviewer must not have to discover this from a red badge.
- If you write the body to a file, put it under `$ARTIFACTS_DIR/`; never inside the repository.

## 4. Hand off the content

Return structured `title`, `body`, and `base`. The deterministic publication node owns the push, create and read-back. Never perform public writes from this command. Keep credentials, local artifact paths and private evaluator content out of the title and body.
