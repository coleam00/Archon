# Prepare the Pull Request

Prepare a clear, reviewer-friendly title and body for the committed work on the current branch. Never modify source, commit, push, create, or edit a PR here. Deterministic publication owns those actions. Describe the pinned candidate below and return title, body, and base through structured output.

$INPUTS.candidate

Draft mode: **$INPUTS.draft** - `true` means open as a draft; anything else, ready for review.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

Record `HEAD_BRANCH=$(git branch --show-current)` before doing anything public; an empty value is a hard failure. Determine the base branch from evidence, in order: an existing PR for that exact branch (read it back and use its recorded number); the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default). Never assume `main`. Use the same resolved base for every diff and command.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. Uncommitted work is a refusal; implementation owns commits. Never sweep unrelated changes.
- Read the complete merge-base diff - not just the file list - and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- Title: concise, human, the meaningful outcome - never an implementation inventory.
- Link the issue with `Closes #N` only when the PR fully resolves it; `Relates to #N` otherwise. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- If `$ARTIFACTS_DIR/red-causes.json` exists, this branch is being delivered while a project check is red. Add a short, plainly-titled section near the top of the body giving each record's cause and the evidence for it from `implementation.md`, and say that the PR's own CI is the check that still decides. A reviewer must not have to discover this from a red badge.
- If you write the body to a file, put it under `$ARTIFACTS_DIR/` - never inside the repository.

## 4. Return the preparation

Return `title`, `body`, and `base`. Use the resolved candidate's existing PR base when present. Include validation evidence that actually ran. Publication checks the candidate again, runs the operator policy when supplied, and performs push/create/readback. Tool restrictions are capability scoping, not an execution sandbox.
