# Open the Pull Request

Create a clear, reviewer-friendly pull request for the committed work on the current branch. The PR itself is the artifact — produce no separate report. You never modify source files; you prepare content for the following deterministic publisher. Every fact belongs in the PR title and body.

Draft mode: **$INPUTS.draft** — `true` means open as a draft; anything else, ready for review.

Context from the run that may narrow this (often empty):

$ARGUMENTS

## 1. Establish the target

Read the repository's forge CLI to establish the exact current branch's existing PR, when present. Use `archon forge resolve --json` for qualified repository identity; never persist raw remote URLs. The publisher pins origin explicitly, including in fork checkouts.

Determine the base branch from evidence, in order: an existing PR for that exact branch in the resolved repository (read it back by explicit number); the repository's documented development flow (steering files, CONTRIBUTING); branch ancestry against likely integration branches (`dev`, `development`, the remote default). Never assume `main`. Use the same resolved base for every diff and command.

## 2. Verify the work is ready

- Confirm the branch is not the base and has commits ahead of it. If intended work sits uncommitted, commit it first following the repository's conventions — staged by name, one coherent outcome per commit, human-sounding message, no AI attribution. Never sweep unrelated changes; if intended and unrelated changes cannot be separated safely, stop and say so.
- Read the complete merge-base diff — not just the file list — and confirm it matches the work described by the run's artifacts.

## 3. Write it

- Read the run's artifacts for content: `$ARTIFACTS_DIR/implementation.md` and anything else relevant under `$ARTIFACTS_DIR/`.
- Find the repository's PR template (`.github/pull_request_template.md` and its supported variants). Use it; fill every applicable section with concrete information and delete instructional comments. No template → problem first, then solution focused on behavior, then validation that actually ran.
- Title: concise, human, the meaningful outcome — never an implementation inventory.
- Link the issue with `Closes #N` only when the PR fully resolves it; `Relates to #N` otherwise. Never infer linkage from a bare number.
- Never add AI attribution, generated-by footers, or robot emoji.
- If `$ARTIFACTS_DIR/red-causes.json` exists, this branch is being delivered while a project check is red. Add a short, plainly-titled section near the top of the body giving each record's cause and the evidence for it from `implementation.md`, and say that the PR's own CI is the check that still decides. A reviewer must not have to discover this from a red badge.
- If you write the body to a file, put it under `$ARTIFACTS_DIR/` — never inside the repository.

## 4. Hand off the content

Return structured `title`, `body`, and `base`. The deterministic publication node owns the push, create and read-back. Never perform public writes from this command. Keep credentials, local artifact paths and private evaluator content out of the title and body.
