# Test Run Report — fix/make-attachments-accessible-to-bash-script-nodes-and-workflows

Updated 2026-08-13 after rebasing this branch onto `origin/dev` (`2379a2c9`, 9 commits ahead of
this branch's previous base — notably `feat(workflows): structural workflow signature
(inputs/returns/with) (#2523)` and `feat: add deterministic workflow dry-run (#2530)`, both of
which touch `packages/workflows/src/executor.ts`). Rebase produced two conflicts, both simple
additive ones (upstream's new `--dry-run`/`--stubs`/`--exec-code`/`--pause-at-gates` flags vs.
this branch's `--attachments` flag) in `packages/cli/src/cli.ts` and
`packages/cli/src/commands/workflow.ts` — resolved by keeping both sides. `executor.ts` itself
auto-merged with no conflict.

Every package below was run via its **own** `package.json` `test` script (the `&&`-separated,
per-file `bun test` invocations CLAUDE.md mandates for mock-pollution isolation) — never a single
`bun test file1 file2 ...` combining files the script keeps separate. Full `bun run test`
(`bun --filter '*' --parallel test`) was attempted first; it aborted early because Bun's
`--parallel` sends SIGINT to every sibling package the moment any one package's script exits
non-zero, so `@archon/workflows` and `bun test ./scripts/` never got a chance to run in that pass
and were re-run standalone afterward.

`bun run test:install` (part of `bun run validate`) fails immediately and unconditionally on this
host: the script's own first check is `[ERROR] Windows is not supported. Please use WSL2` — a
host-platform gate, not a test result. Skipped per CONTRIBUTING.md's guidance that
`test:install` is a binary-packaging smoke test orthogonal to this change.

This branch's actual changes (`git diff --stat origin/dev...HEAD`): `packages/cli/` (`cli.ts`,
`commands/workflow.ts`), `packages/core/src/orchestrator/` (`orchestrator-agent.ts`,
`orchestrator.ts`), `packages/workflows/src/executor.ts` (+ its test), plus
`.archon/commands/defaults/archon-assist.md` and `.docs`/`docs-web` documentation.

| Package             | Result                                                                             | Status                                   | Description (why the failure is outside our changes)                                                                                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@archon/core`      | All splits pass, 0 fail                                                            | OK                                       | Touched by this branch (`orchestrator-agent.ts`, `orchestrator.ts`) — every test passed, including the updated `orchestrator-agent.test.ts`                                                                                                                                                |
| `@archon/cli`       | 18 pass, 2 fail (`serve.test.ts`)                                                  | **NOT OK** (pre-existing, deterministic) | Touched by this branch (`cli.ts`, `commands/workflow.ts`) — `workflow.test.ts` (215/215) and `cli.test.ts` (54/54), the files this branch's merge conflict resolution actually touches, both passed clean. The failing file, `commands/serve.test.ts`, is untouched. See description below |
| `@archon/adapters`  | All splits pass, 0 fail                                                            | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |
| `@archon/server`    | All splits pass, 0 fail                                                            | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |
| `@archon/providers` | 17 pass, 1 fail (`pathKind` broken-symlink test, `claude/binary-resolver.test.ts`) | **NOT OK** (pre-existing, deterministic) | Untouched by this branch. Windows filesystem-permission limitation of this dev host — see description below                                                                                                                                                                                |
| `@archon/web`       | All splits pass, 0 fail                                                            | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |
| `@archon/isolation` | All splits pass, 0 fail                                                            | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |
| `@archon/paths`     | All splits pass, 0 fail                                                            | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |
| `@archon/git`       | All splits pass, 0 fail                                                            | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |
| `@archon/workflows` | All splits pass, 0 fail — **except** `load-command-prompt.test.ts` (1 fail)        | **NOT OK** (pre-existing, deterministic) | Touched by this branch (`executor.ts`, auto-merged with upstream's new dry-run/subrun features during rebase) — `executor.test.ts` (87/87) and `subrun.test.ts` (59/59, upstream's new structural-signature feature, unaffected by the rebase) both passed clean. See description below    |
| `scripts/` (root)   | 16 pass, 0 fail                                                                    | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                   |

---

## Failure descriptions

### `@archon/cli` — `serve.test.ts` (pre-existing, deterministic)

**Tests:**

1. `downloadWebDist > verifies against the embedded hash without fetching checksums.txt`
2. `downloadWebDist > falls back to remote checksums.txt when the embedded hash is empty`

**Why this is outside our changes:** a Windows-specific `tar` path-quoting bug — the temp path gets
a literal backslash inserted before the drive-letter colon (`C\:\\Users\\...`), so `tar` can't find
what it's extracting. This is a tooling/environment issue in `serve.ts`'s tarball-extraction call,
unrelated to attachment accessibility. This branch touches `cli.ts` and `commands/workflow.ts`,
not `commands/serve.ts`/`serve.test.ts`. Same failure, byte-identical, before and after the rebase
onto `origin/dev`.

### `@archon/providers` — `pathKind` test (pre-existing, deterministic)

**Test:** `pathKind > returns "missing" for a broken symlink without throwing` (`claude/binary-resolver.test.ts`)

**Why this is outside our changes:** `EPERM: operation not permitted, symlink` — the test creates a
broken symlink as a fixture, which requires Administrator privileges or Developer Mode on Windows,
neither guaranteed on this dev host. A host environment limitation, not application code — fails
identically regardless of which branch is checked out. `git diff --stat origin/dev...HEAD` confirms
`packages/providers/` has zero changes on this branch.

### `@archon/workflows` — `load-command-prompt.test.ts` (pre-existing, deterministic)

**Test:** `loadCommandPrompt — home-scope resolution > resolves a symlinked home command and reads
target content`

**Why this is outside our changes:** same Windows symlink-`EPERM` root cause as above —
`fs.symlink()` fixture setup fails without elevated privileges/Developer Mode. This branch touches
`executor.ts` (and its test file), not `load-command-prompt.ts`/`.test.ts` — and `executor.test.ts`
itself, including this branch's `ARCHON_ATTACHMENTS` tests, passed all 87 tests cleanly after the
rebase.

---

## Rebase-specific verification

Because `executor.ts` was auto-merged (no conflict markers) between this branch's attachment
plumbing and upstream's new `dry-run.ts` / sub-run `inputs`/`returns`/`with` feature (#2523,
#2530), `subrun.test.ts` (upstream, untouched by this branch) was run standalone and confirmed
clean: **59 pass, 0 fail** — both on pristine `origin/dev` (verified via a disposable comparison
worktree) and on this branch post-rebase. No regression introduced by the merge.

An earlier pass at this verification produced 55 spurious failures in `subrun.test.ts` by running
it combined with three other test files in a single `bun test` invocation — that is exactly the
`mock.module()` cross-file pollution CLAUDE.md warns about (Bun's mock cache is process-global and
`mock.restore()` does not undo it). Re-running each file in its own isolated `bun test` invocation,
matching `package.json`'s own `&&`-separated splits, made the failures disappear entirely. Noted
here as a testing-methodology gotcha, not a code issue.

## Conclusion

No failure is caused by `fix/make-attachments-accessible-to-bash-script-nodes-and-workflows` or by rebasing it onto the
latest `origin/dev`. All three failures are the same deterministic, pre-existing Windows-host
environment issues (symlink `EPERM` ×2, `tar` path-quoting) confirmed unchanged before and after
the rebase — none newly introduced, and none in a file this branch modifies. Every test in a file
this branch actually touches (`executor.test.ts`, `orchestrator-agent.test.ts`, `cli.test.ts`,
`workflow.test.ts`) passed cleanly, and the auto-merged `executor.ts` was independently verified
not to regress upstream's new `subrun.test.ts` suite.
