# Test Run Report — feat/slack-and-other-adapters-attachment-accessibility

Updated 2026-08-13 after **rebasing this branch onto
`fix/make-attachments-accessible-to-bash-script-nodes-and-workflows`** (which had, in the interim,
been separately rebased onto `dev` and amended with a test-report fixture cleanup — see that
branch's own `.docs/fix-make-attachments-accessible-in-workflows.fail.md`). This branch's own
prior commit history contained an older copy of that same fix commit (`9c08beef`, predating the
sibling branch's later amend); replaying it during a plain `git rebase` would have collided with
the sibling's now-updated version of the identical change. Used
`git rebase --onto fix/make-attachments-accessible-to-bash-script-nodes-and-workflows 9c08beef
feat/slack-and-other-adapters-attachment-accessibility` instead, which skips the superseded
duplicate and replays only this branch's actual unique commit
(`feat(adapters): consolidate attachment download across Slack, Telegram, Discord`) on top of the
sibling's tip. **Zero conflicts** — the rebase applied cleanly in one step.

This branch's diff scope is now materially narrower than before the rebase: the fix branch's
`ARCHON_ATTACHMENTS`/executor/CLI/orchestrator changes are inherited from the new base rather than
carried as this branch's own commits. This branch's actual changes
(`git diff --stat fix/make-attachments-accessible-to-bash-script-nodes-and-workflows...HEAD`) are
now confined to `packages/adapters/` (Slack/Telegram/Discord adapters, `attachment-download.ts`
util, `index.ts` re-exports) and `packages/server/src/index.ts`, plus this `.docs/` documentation
set — `packages/cli/`, `packages/core/src/orchestrator/`, and `packages/workflows/src/executor.ts`
are no longer in this branch's own diff.

Every package below was run via its **own** `package.json` `test` script (the `&&`-separated,
per-file `bun test` invocations CLAUDE.md/AGENTS.md mandate for mock-pollution isolation) — never a
single `bun test file1 file2 ...` combining files the script keeps separate. Full `bun run test`
(`bun --filter '*' --parallel test`) was run first; as documented precedent warns, Bun's
`--parallel` sends SIGINT to every sibling package the moment any one package's script exits
non-zero, so `@archon/workflows` and `@archon/isolation` (mid-split) never got a chance to finish in
that pass and were re-run standalone afterward, along with `@archon/core` (to distinguish a
suspected flaky failure from a real one) and `@archon/cli` (to confirm its failure reproduces
outside the aborted parallel run). `bun test ./scripts/` (the tail of `bun run test`, never reached
after the parallel abort) was run separately and passed clean.

`bun run test:install` (part of `bun run validate`) fails immediately and unconditionally on this
host: the script's own first check is `[ERROR] Windows is not supported. Please use WSL2` — a
host-platform gate, not a test result. Skipped per CONTRIBUTING.md's guidance that `test:install`
is a binary-packaging smoke test orthogonal to this change. `check:bundled`, `check:bundled-skill`,
`check:bundled-schema`, `check:pi-vendor-map`, `check:capability-matrix`, `type-check`,
`lint --max-warnings 0`, and `format:check` were all run and passed with zero findings.

| Package             | Result                                                                                  | Status                                   | Description                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@archon/adapters`  | 404 pass, 0 fail (268+10+73+5+48 across 5 splits/16 files)                              | OK                                       | Touched by this branch (Slack/Telegram/Discord adapters, `attachment-download.ts`)                                                                                                                                                                                                        |
| `@archon/server`    | 137 pass, 0 fail (58+29+27+23 across 4 splits)                                          | OK                                       | Touched by this branch (`index.ts`)                                                                                                                                                                                                                                                       |
| `@archon/paths`     | 279 pass, 13 skip, 0 fail                                                               | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                  |
| `@archon/git`       | 196 pass, 0 fail                                                                        | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                  |
| `@archon/providers` | 258 pass, 0 fail                                                                        | OK                                       | Untouched by this branch — no `pathKind` symlink failure this run (host-dependent; see `@archon/workflows` below for the same root cause recurring elsewhere)                                                                                                                             |
| `@archon/web`       | 968 pass, 0 fail                                                                        | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                  |
| `@archon/core`      | 1225 pass, 0 fail (standalone rerun)                                                    | OK                                       | Untouched by this branch. Under the `--parallel` run, one split showed `conversation-lock.test.ts`'s FIFO-ordering test failing (a `setTimeout`-based timing assertion); a clean standalone rerun passed 100% — flaky under host contention, not a real regression. See description below |
| `@archon/isolation` | 341 pass, 1 fail (standalone rerun)                                                     | **NOT OK** (pre-existing, flaky)         | Untouched by this branch — see description below                                                                                                                                                                                                                                          |
| `@archon/workflows` | 1019 pass, 0 fail — **except** `load-command-prompt.test.ts` (1 fail, standalone rerun) | **NOT OK** (pre-existing, deterministic) | Untouched by this branch (confirmed: `git diff --stat fix/...HEAD -- packages/workflows` is empty). See description below                                                                                                                                                                 |
| `@archon/cli`       | 418 pass, 2 fail (`serve.test.ts`, standalone rerun)                                    | **NOT OK** (pre-existing, deterministic) | Untouched by this branch (confirmed: `git diff --stat fix/...HEAD -- packages/cli` is empty). See description below                                                                                                                                                                       |
| `scripts/`          | 16 pass, 0 fail                                                                         | OK                                       | Untouched by this branch                                                                                                                                                                                                                                                                  |

---

## Failure descriptions

### `@archon/core` — `conversation-lock.test.ts` FIFO test (flaky under host contention, not reproduced standalone)

**Test:** `ConversationLockManager > queued messages process in order after completion`

**Cause:** a hardcoded `setTimeout(resolve, 100)` wait racing against queued-callback execution
order — a timing assertion of exactly the kind CLAUDE.md/AGENTS.md warns keeps tests
non-deterministic ("no flaky timing... dependence without guardrails"). Failed only when running
under `bun --filter '*' --parallel test`, where ten packages' subprocess-spawning test suites
compete for the same cores (see AGENTS.md's `--parallel` note). A standalone
`bun --filter @archon/core test` rerun passed all 1225 tests including this one. Not caused by this
branch — `packages/core/` is untouched by this branch's diff against its new base.

### `@archon/isolation` — `overlay-scripts.test.ts` (pre-existing, flaky/timing-sensitive)

**Test (this run):** `apply script — C2 special files + setuid > setuid/setgid/sticky bits are
stripped from applied files` (previous same-session run under `--parallel` instead failed a
_different_ sub-test in the same file — `C1 whiteout-name traversal > ".wh." (empty decoded name)
does NOT wipe the parent dir` — both hit the file's 5000ms per-test timeout budget on this host).

**Cause:** subprocess-driven filesystem fixture setup (overlay whiteout/setuid simulation scripts)
that occasionally exceeds the test's hardcoded 5s budget on this Windows dev host — different
specific assertion fails each run, which is itself the signature of a timing-budget issue rather
than a logic defect. `git diff --stat fix/...HEAD -- packages/isolation` is empty — this branch
never touches isolation code.

### `@archon/workflows` — `load-command-prompt.test.ts` (pre-existing, deterministic)

**Test:** `loadCommandPrompt — home-scope resolution > resolves a symlinked home command and reads
target content`

**Cause:** Windows symlink-`EPERM` — `fs.symlink()` fixture setup requires Administrator privileges
or Developer Mode, which this host doesn't have. Deterministic (fails every run). Already
documented as a known pre-existing baseline issue in this same session's sibling-branch report
(`.docs/fix-make-attachments-accessible-in-workflows.fail.md`) and in earlier sessions'
(`.docs/unified-channel-ref.pr.md`, `.docs/named-adapter-channels.fail.md`,
`.docs/project-to-defaultWorkflow-mapping.fail.md`). `git diff --stat fix/...HEAD --
packages/workflows` is empty — this branch no longer touches `executor.ts` post-rebase (that change
now lives in the base).

### `@archon/cli` — `serve.test.ts` (pre-existing, deterministic)

**Tests:**

1. `downloadWebDist > verifies against the embedded hash without fetching checksums.txt`
2. `downloadWebDist > falls back to remote checksums.txt when the embedded hash is empty`

**Cause:** the known Windows `tar` path-quoting bug (a literal backslash inserted before the
drive-letter colon in the temp path, so `tar` can't find what it's extracting). Deterministic, same
failure documented byte-for-byte in this session's sibling-branch report and earlier sessions'
(`.docs/named-adapter-channels.fail.md`, `.docs/project-to-defaultWorkflow-mapping.fail.md`).
`git diff --stat fix/...HEAD -- packages/cli` is empty — this branch no longer touches `cli.ts`/
`commands/workflow.ts` post-rebase (that change now lives in the base).

---

## Conclusion

No failure is caused by `feat/slack-and-other-adapters-attachment-accessibility`. Every failure
falls into one of two already-documented, host-specific, pre-existing categories — Windows
symlink-`EPERM` (`workflows`) and Windows `tar` path-quoting (`cli`) — plus one newly-confirmed
flaky timing test (`core`, passes clean standalone) and one timing-budget-sensitive fixture suite
(`isolation`, different sub-test fails per run). None is in a file this branch's diff against its
new base touches; every test in a file this branch actually modifies
(`attachment-download.test.ts`, the Slack/Telegram/Discord adapter tests) passed cleanly — 404/404
in `@archon/adapters`, 137/137 in `@archon/server`.
