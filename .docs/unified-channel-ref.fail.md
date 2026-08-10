# Test Run Report — feat/add-ChannelReference-for-adapter'channel-identity

Updated 2026-08-13 after rebasing this branch onto `origin/dev` (`2379a2c9`, 9 commits ahead of
this branch's previous base). Unlike the two most recently rebased sibling branches, this rebase
produced **three conflicts** — `CLAUDE.md`, `packages/workflows/src/dag-executor.ts`, and
`packages/workflows/src/executor-shared.ts` — because this branch touches the same
`executor-shared.ts`/`dag-executor.ts` prompt-substitution machinery as upstream's new
`inputs`/`with:`/`returns` sub-run feature (#2523).

- **`CLAUDE.md`**: not a real content conflict — upstream consolidated `CLAUDE.md` into
  `AGENTS.md` (commit `ae8d39a3`, `docs: consolidate agent instructions into AGENTS.md`),
  reducing it to a one-line pointer (`Agent rules: read @AGENTS.md`). This branch's only actual
  change to that content was one new line in the "Variable Substitution" list documenting
  `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME`. Resolved by taking upstream's one-line `CLAUDE.md`
  stub as-is and moving the new variable-doc line into `AGENTS.md`'s now-canonical Variable
  Substitution list instead.
- **`dag-executor.ts`** (4 conflicts) and **`executor-shared.ts`** (4 conflicts): every conflict
  was the same shape — this branch's `{ stateDir, channelRef }` options object at a
  `substituteWorkflowVariables()`/`buildPromptWithContext()` call site colliding with upstream's
  `{ stateDir, inputs: resolveRunInputs(workflowRun) }` at the identical call site. Resolved by
  merging both fields into one options object (`{ stateDir, inputs, channelRef }`) at every site,
  plus merging the corresponding `options?: {...}` type signatures and doc-comment blocks. Full
  type-check (all 10 packages) and the `dag-executor.test.ts` (450/450), `executor-shared.test.ts`
  (101/101), `executor.test.ts` (84/84), and `subrun.test.ts` (59/59, upstream's own new feature,
  untouched by this branch) test files all pass clean post-merge — confirming the merge preserved
  both features without regressing either.

Every package below was run via its **own** `package.json` `test` script (the `&&`-separated,
per-file `bun test` invocations CLAUDE.md/AGENTS.md mandate for mock-pollution isolation), run
sequentially per package rather than through `bun --filter '*' --parallel test` (which SIGINTs
every sibling package the instant one package's script exits non-zero). Where a package's own
`&&` chain stopped early at a pre-existing failure, the remaining files in that chain were run
individually afterward to confirm full coverage.

`bun run type-check`, `bun run lint --max-warnings 0`, `bun run format:check`, and all five
generated-file drift checks were all re-run post-rebase and pass clean. `bun run test:install`
fails immediately and unconditionally on this host (`[ERROR] Windows is not supported. Please use
WSL2`) — a host-platform gate, not a test result; skipped per CONTRIBUTING.md's guidance that
it's a binary-packaging smoke test orthogonal to this change.

This branch's actual changes (`git diff --stat origin/dev...HEAD`): `packages/adapters/`
(Telegram/Discord/GitHub/GitLab/Gitea — `channelRef` construction), `packages/cli/src/commands/
chat.ts`, `packages/core/` (`orchestrator-agent.ts`, `orchestrator.ts`, `prompt-builder.ts`,
`types/index.ts`), `packages/server/` (`index.ts`, `routes/api.ts`), `packages/workflows/`
(`dag-executor.ts`, `deps.ts`, `executor-shared.ts`, `executor.ts` — the `ChannelReference` type
and `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME` threading), plus `.docs`/`docs-web` documentation and
`AGENTS.md` (formerly `CLAUDE.md`).

| Package             | Result                                                                      | Status                                   | Description (why the failure is outside our changes)                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@archon/adapters`  | All splits pass, 0 fail                                                     | OK                                       | Touched by this branch (Telegram/Discord/GitHub/GitLab/Gitea `channelRef` wiring) — every test passed                                                                                                                                                                           |
| `@archon/core`      | All splits pass, 0 fail                                                     | OK                                       | Touched by this branch (`orchestrator-agent.ts`, `orchestrator.ts`, `prompt-builder.ts`, `types/index.ts`) — every test passed                                                                                                                                                  |
| `@archon/server`    | All splits pass, 0 fail                                                     | OK                                       | Touched by this branch (`index.ts`, `routes/api.ts`) — every test passed                                                                                                                                                                                                        |
| `@archon/web`       | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                        |
| `@archon/isolation` | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                        |
| `@archon/git`       | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                        |
| `@archon/paths`     | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                        |
| `@archon/workflows` | All splits pass, 0 fail — **except** `load-command-prompt.test.ts` (1 fail) | **NOT OK** (pre-existing, deterministic) | Touched by this branch AND manually merged during rebase (`dag-executor.ts`, `deps.ts`, `executor-shared.ts`, `executor.ts`) — `dag-executor.test.ts` (450/450), `executor-shared.test.ts` (101/101), `executor.test.ts` (84/84), and `subrun.test.ts` (59/59) all passed clean |
| `@archon/providers` | 17 pass, 1 fail (`pathKind` broken-symlink test)                            | **NOT OK** (pre-existing, deterministic) | Untouched by this branch. Same root cause as the `workflows` failure — see description below                                                                                                                                                                                    |
| `@archon/cli`       | 18 pass, 2 fail (`serve.test.ts`)                                           | **NOT OK** (pre-existing, deterministic) | Touched by this branch (`commands/chat.ts` only) — the failing file, `commands/serve.test.ts`, is untouched                                                                                                                                                                     |
| `scripts/` (root)   | 16 pass, 0 fail                                                             | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                        |

---

## Failure descriptions

### `@archon/workflows` — `load-command-prompt.test.ts` (pre-existing, deterministic)

**Test:** `loadCommandPrompt — home-scope resolution > resolves a symlinked home command and reads
target content`

**Why this is outside our changes:** `EPERM: operation not permitted, symlink` — the test creates
a broken symlink fixture, which requires Administrator privileges or Developer Mode on Windows,
neither guaranteed on this dev host. A host environment limitation, not application code — fails
identically regardless of which branch is checked out, before and after the rebase onto
`origin/dev`. This branch touches `dag-executor.ts`, `deps.ts`, `executor-shared.ts`, and
`executor.ts` (exactly where `ChannelReference` and its `$ADAPTER`/`$CHANNEL_ID`/`$CHANNEL_NAME`
substitution live), but not `load-command-prompt.ts`/`.test.ts`.

### `@archon/providers` — `pathKind` test (pre-existing, deterministic)

**Test:** `pathKind > returns "missing" for a broken symlink without throwing`

**Why this is outside our changes:** same root cause as above. `git diff --stat
origin/dev...HEAD` confirms `packages/providers/` has zero changes on this branch.

### `@archon/cli` — `serve.test.ts` (pre-existing, deterministic)

**Tests:**

1. `downloadWebDist > verifies against the embedded hash without fetching checksums.txt`
2. `downloadWebDist > falls back to remote checksums.txt when the embedded hash is empty`

**Why this is outside our changes:** a Windows-specific `tar` path-quoting bug in `serve.ts`'s
tarball-extraction call, unrelated to `ChannelReference`. This branch touches only
`packages/cli/src/commands/chat.ts` (adding `channelRef` construction), not
`commands/serve.ts`/`serve.test.ts`.

---

## Conclusion

No failure is caused by `feat/add-ChannelReference-for-adapter'channel-identity` or by rebasing it
onto the latest `origin/dev`. All three failures are the same deterministic, pre-existing
Windows-host environment issues (symlink `EPERM` ×2, `tar` path-quoting) confirmed unchanged before
and after the rebase — none newly introduced, and none in a file this branch modifies. Every test
in a file this branch actually touches or that this rebase manually merged — `dag-executor.test.ts`,
`executor-shared.test.ts`, `executor.test.ts`, `subrun.test.ts`, the adapter tests, and the
orchestrator tests — passed cleanly, as did `type-check`, `lint --max-warnings 0`,
`format:check`, and every generated-file drift check.
