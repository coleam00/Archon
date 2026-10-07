# Implement and open the pull request

Implement the plan you just wrote in `$ARTIFACTS_DIR/plan.md`, prove it, commit it, push it, and open the pull request. You keep owning this delivery afterwards: a fresh reviewer will judge your pull request and you will make every correction in this same conversation.

## How to work

1. Make the project runnable: install missing dependencies with the project's own package manager in locked mode. Never update a lockfile.
2. Work on the current branch of this checkout. Never switch branches, rebase, merge the base in, or stash.
3. Execute the plan's tasks in dependency order. Live code beats the plan's assumptions: follow the code and record the deviation, unless it makes the intended outcome ambiguous; then stop and say so.
4. Prefer the simplest change that solves the actual problem; if the path grows complicated, stop and reconsider. Add nothing speculative: no config, flags, abstractions, guards, or fallbacks without a current requirement or concrete failure mode. Remove machinery your change supersedes.
5. Express invariants with the project's strongest tools; avoid type escape hatches when a sound type is practical.
6. Write focused tests that prove the changed behavior; for a bug, one that fails before the fix and passes after when practical. No coverage theater.
7. Keep comments and documentation truthful. Comment only what code cannot say.
8. When the change touches agent or LLM behavior, let the model interpret and the code validate: never reconstruct intent from prose with regexes or keyword lists.

## Prove it

Before you commit, the project's own type-check, lint, and tests have all run and passed, through its documented aggregate command when it has one. Narrow runs are for iterating; they never replace that floor. Never invent a command the project does not define; say so when a class of check does not exist. Map every acceptance item in the plan to an observation. If a required check fails and your change did not cause it, record the exact check and the evidence (for example, the same check failing at the starting commit).

## Commit and open the pull request

- Commit by outcome, staging files by name (never `git add -A`). Write messages as a human explains an outcome. No AI attribution.
- Push the branch with an explicit refspec: `git push origin HEAD:refs/heads/$(git branch --show-current)`. Never force-push.
- Every `gh pr` command names the repository `origin` points at with `--repo <owner>/<repo>`: in a clone of a fork, gh otherwise resolves the upstream parent and publishes your diff there.
- If an open pull request already has this branch as its head (`gh pr list --repo <owner>/<repo> --head <branch> --state open`), use it. Otherwise open one against `$BASE_BRANCH` with `gh pr create --repo <owner>/<repo>`, not as a draft. Title: the outcome, concise. Body: the problem first, then the solution briefly, then the validation evidence; link the source issue with a closing keyword when the work has one. No AI attribution.
- Read the pull request back (`gh pr view <number> --repo <owner>/<repo> --json number,url,headRefName,headRefOid`) and confirm its head is this branch at your pushed commit.

## Report

Write `$ARTIFACTS_DIR/implementation.md`: what changed and why, deviations from the plan, validation commands with their results, commits, and the pull request URL. Every later pass updates this file rather than starting another.

## If you cannot finish

If the work is blocked or required validation cannot pass because of your change, do not open a pull request. Declare `green: false` with the blocker, and report the PR as `{ repo: { host: "", path: "" }, number: 0, url: "" }`.

## Declare

- `green` — true only when the work is complete, every required check ran and passed (or its failure is proven not yours and recorded), and the pull request is open with your pushed head.
- `pr` — the opened pull request: `repo.host` (for example `github.com`), `repo.path` (`owner/repo`), `number`, and `url`.
- `summary` — what you built, the validation evidence, and the pull request URL, or the blocker.
