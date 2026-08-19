# Test Run Report — feat/project-default-workflow-dispatch

Updated 2026-08-13 after rebasing this branch onto `origin/dev` (`2379a2c9`, 9 commits ahead of
this branch's previous base). The rebase was **clean — zero conflicts** — because upstream's 9
commits (notably `feat(workflows): structural workflow signature (inputs/returns/with) (#2523)`
and `feat: add deterministic workflow dry-run (#2530)`) touch only `packages/workflows/`, while
this branch's changes are scoped entirely to `packages/core/src/orchestrator/`,
`packages/core/src/config/`, `packages/core/package.json`, and docs — no file overlap.

Every package below was run via its **own** `package.json` `test` script (the `&&`-separated,
per-file `bun test` invocations CLAUDE.md mandates for mock-pollution isolation), run
sequentially per package rather than through `bun --filter '*' --parallel test` — the `--parallel`
form sends SIGINT to every sibling package the instant any one package's script exits non-zero,
which previously produced a misleading aggregate exit code and cut two packages off before they
could finish (see the prior report's note on this in `pr.md`). Running each package's `bun run
test` to completion, one at a time, avoids that entirely.

`bun run type-check`, `bun run lint --max-warnings 0`, `bun run format:check`, and all five
generated-file drift checks (`check:bundled`, `check:bundled-skill`, `check:bundled-schema`,
`check:pi-vendor-map`, `check:capability-matrix`) were all re-run post-rebase and pass clean.

`bun run test:install` fails immediately and unconditionally on this host: the script's own first
check is `[ERROR] Windows is not supported. Please use WSL2` — a host-platform gate, not a test
result. Skipped per CONTRIBUTING.md's guidance that `test:install` is a binary-packaging smoke
test orthogonal to this change.

This branch's actual changes (`git diff --stat origin/dev...HEAD`): `packages/core/package.json`,
`packages/core/src/config/config-loader.ts`, `packages/core/src/config/config-types.ts`,
`packages/core/src/orchestrator/dispatch.ts` (+ its test), `packages/core/src/orchestrator/
orchestrator-agent.ts` (+ its test), plus `.docs`/`docs-web` documentation.

| Package             | Result                                                                      | Status                                   | Description (why the failure is outside our changes)                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@archon/core`      | All splits pass, 0 fail                                                     | OK                                       | Touched by this branch (`dispatch.ts`, `orchestrator-agent.ts`, `config-loader.ts`, `config-types.ts`) — every test passed, including `dispatch.test.ts` and the updated `orchestrator-agent.test.ts` |
| `@archon/adapters`  | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                              |
| `@archon/server`    | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                              |
| `@archon/web`       | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                              |
| `@archon/isolation` | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                              |
| `@archon/git`       | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                              |
| `@archon/paths`     | All splits pass, 0 fail                                                     | OK                                       | Untouched by this branch                                                                                                                                                                              |
| `@archon/workflows` | All splits pass, 0 fail — **except** `load-command-prompt.test.ts` (1 fail) | **NOT OK** (pre-existing, deterministic) | Untouched by this branch. Windows filesystem-permission limitation of this dev host — see description below                                                                                           |
| `@archon/providers` | 17 pass, 1 fail (`pathKind` broken-symlink test)                            | **NOT OK** (pre-existing, deterministic) | Untouched by this branch. Same root cause as the `workflows` failure — see description below                                                                                                          |
| `@archon/cli`       | 18 pass, 2 fail (`serve.test.ts`)                                           | **NOT OK** (pre-existing, deterministic) | Untouched by this branch. Unrelated Windows `tar` bug — see description below                                                                                                                         |
| `scripts/` (root)   | 16 pass, 0 fail                                                             | OK                                       | Untouched by this branch                                                                                                                                                                              |

---

## Failure descriptions

### `@archon/workflows` — `load-command-prompt.test.ts` (pre-existing, deterministic)

**Test:** `loadCommandPrompt — home-scope resolution > resolves a symlinked home command and reads
target content`

**Error:**

```
EPERM: operation not permitted, symlink 'C:\Users\...\archon-command-source-<rand>\linked.md' ->
'C:\Users\...\archon-home-<rand>\commands\linked.md'
    syscall: "symlink"
    code: "EPERM"
```

**Why this is outside our changes:** the test calls `fs.symlink()` as a fixture-setup step.
Creating filesystem symlinks on Windows requires Administrator privileges or Developer Mode —
neither is guaranteed on this dev host, so the OS refuses the syscall before the test's actual
assertions run. This is a Windows-host environment limitation, not application code — it fails
identically regardless of which branch is checked out, before and after the rebase onto
`origin/dev`. `git diff --stat origin/dev...HEAD` confirms this branch never touches
`load-command-prompt.ts`/`.test.ts`.

### `@archon/providers` — `pathKind` test (pre-existing, deterministic)

**Test:** `pathKind > returns "missing" for a broken symlink without throwing`

**Why this is outside our changes:** same root cause as above — `EPERM: operation not permitted,
symlink` when the test creates a broken symlink fixture, blocked by the same Windows privilege
requirement. `git diff --stat origin/dev...HEAD` confirms `packages/providers/` has zero changes
on this branch.

### `@archon/cli` — `serve.test.ts` (pre-existing, deterministic)

**Tests:**

1. `downloadWebDist > verifies against the embedded hash without fetching checksums.txt`
2. `downloadWebDist > falls back to remote checksums.txt when the embedded hash is empty`

**Error (both, identical shape):**

```
error: tar extraction failed (exit 2): tar: C\:\\Users\\Admin\\AppData\\Local\\Temp\\serve-webdist-test-<rand>\target-<name>.tmp: Cannot open: No such file or directory
tar: Error is not recoverable: exiting now
```

**Why this is outside our changes:** a Windows-specific `tar` path-quoting bug — the temp path gets
a literal backslash inserted before the drive-letter colon (`C\:\\Users\\...`), so `tar` can't find
what it's extracting. This is an environment/tooling issue in `serve.ts`'s tarball-extraction call,
unrelated to per-project default workflow dispatch. `git diff --stat origin/dev...HEAD` confirms
`packages/cli/` has zero changes on this branch.

---

## Conclusion

No failure is caused by `feat/project-default-workflow-dispatch` or by rebasing it onto the latest
`origin/dev`. All three failures are the same deterministic, pre-existing Windows-host environment
issues (symlink `EPERM` ×2, `tar` path-quoting) confirmed unchanged before and after the rebase —
none newly introduced, and none in a file this branch modifies. `git diff --stat origin/dev...HEAD`
confirms this branch's actual changes are scoped to `@archon/core` (`dispatch.ts`,
`orchestrator-agent.ts`, `config-loader.ts`, `config-types.ts`) and docs. Every test in a file this
branch touches — including `dispatch.test.ts` and `orchestrator-agent.test.ts` — passed cleanly,
as did `type-check`, `lint --max-warnings 0`, `format:check`, and every generated-file drift check.
