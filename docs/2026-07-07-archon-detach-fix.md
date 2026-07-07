# Archon `--detach` Fix — make background dispatches survive

> **For the human executor.** Small, surgical fix to Archon's own CLI. Companion to
> `.agents/plans/2026-07-05-archon-mid-run-death-problem-record.md` and the retro entry
> in `docs/retros/worked-failures.md` (2026-07-06, `dispatch-shell-kill-breaks-bash-spawn`).
> You said you'll run this yourself — it's written to be self-contained.

**Goal:** Make `archon workflow run --detach` actually detach on Windows, so a dispatched
run finishes on its own (commit + PR + CI-watch) instead of dying ~1s in and forcing a manual finish.

**Root cause (proven):** Archon's detach helper spawns the background child with **`Bun.spawn(...)` + `child.unref()` but no `detached: true`**. `unref()` lets the parent stop *waiting* for the child, but does **not** put the child in its own process group — so when the launching shell/console tears down (right after the parent returns), Windows kills the "detached" child with it. Evidence: the newest real detach log, `~/.archon/logs/detached-run-cli-1783254850212-z1bv6j.log`, stops **dead mid-line at `worktree_creating`** with **no error** (a killed process, not a crashed one), ~1s after start. The same codebase's `setup.ts` already detaches correctly with Node's `spawn(..., { detached: true })` — this one file just didn't.

**Not the cause (ruled out):** Windows sleep/hibernate. The Windows event log shows only 3–6 second standby blips and **none during any failed run**, and the runs computed continuously for tens of minutes (a 20-min test actually ran). The machine was awake. Prolonging sleep is fine as insurance for genuinely-unattended overnight runs, but it does not fix this.

**Tech stack:** Bun 1.3, TypeScript, `@archon/cli`. The fix is one import + one spawn call.

## Global Constraints

- **No rebuild needed — the edit is live.** Archon runs from source: `~/.bun/bin/archon.bunx` → `@archon/cli/src/cli.ts`, the bun global `@archon/cli` is linked to `D:\Project\Archon-template\packages\cli`, runtime stack traces resolve to `D:\Project\Archon-template\...`, and `scripts/build-binaries.sh` has **no Windows target**. So the next `archon` invocation picks up the change. *(If you ever switch to a compiled binary, you'd instead run `bun run build:binaries` and reinstall — not applicable today.)*
- **This is core Archon tooling.** The fix affects `--detach` for **every** repo and workflow, not just marphob-page.
- **Touch only `spawnDetachedWorkflowRun`.** Do **not** change `buildDetachedRunCmd` (the pure argv builder is correct and unit-tested).
- **This behavior is not cleanly unit-testable** (it's OS process-detachment). The acceptance check is a **live `--detach` run** that survives past `worktree_creating` (Task 2).
- **Windows Job-Object caveat.** `detached: true` is the standard fix and mirrors `setup.ts`; if the launching shell wraps children in a *kill-on-close* Job Object it may still not be enough — that's what **Task 3** (the `start /b` breakaway fallback) is for. Try Task 1 first; only do Task 3 if the Task 2 live test still dies at ~1s.

---

## File Structure

| File | Change |
|---|---|
| `D:\Project\Archon-template\packages\cli\src\commands\workflow.ts` | Add a `node:child_process` import; replace the `Bun.spawn` call in `spawnDetachedWorkflowRun` with Node's `spawn(..., { detached: true, windowsHide: true })`. |

Everything else (the log-fd handling, `buildDetachedRunCmd`, the `--detach` re-invoke argv) stays exactly as-is.

---

## Task 1: Make the detached child truly detach

**File:** `D:\Project\Archon-template\packages\cli\src\commands\workflow.ts`

**Interfaces:**
- Consumes: `cmd: string[]` from `buildDetachedRunCmd` (unchanged), `logFd: number | undefined`, `cwd: string`.
- Produces: same function signature (`spawnDetachedWorkflowRun(...) → string | null`); only the spawn mechanism changes.

- [ ] **Step 1: Add the Node spawn import.** Near the existing `node:` imports (around line 29–30, next to `import { join } from 'node:path';` and `import { mkdirSync, openSync, closeSync } from 'node:fs';`), add:

```ts
import { spawn } from 'node:child_process';
```

- [ ] **Step 2: Replace the spawn call.** In `spawnDetachedWorkflowRun` (around lines 194–201), replace this:

```ts
  try {
    const child = Bun.spawn({
      cmd,
      cwd,
      env: process.env,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    });
    child.unref();
  } finally {
```

with this:

```ts
  try {
    // Node's spawn with `detached: true` makes the child a new process-group
    // leader, so it survives the parent's exit. Bun.spawn + unref() does NOT
    // detach on Windows — the child was killed ~1s in (at worktree_creating)
    // when the launching shell/console tore down. Mirrors setup.ts's proven
    // `spawn(..., { detached: true })` pattern. `windowsHide` keeps it headless.
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      env: process.env,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } finally {
```

Leave the `finally { ... closeSync(logFd) ... }` block below it untouched.

*(Note on `cmd[0]!`: `buildDetachedRunCmd` always returns a non-empty array (`[...baseCmd, ...]`), so `cmd[0]` is defined. If your tsconfig objects to `!`, use `const [command, ...args] = cmd; spawn(command!, args, { ... })` instead.)*

- [ ] **Step 3: Typecheck + existing tests stay green.** Run from `D:\Project\Archon-template`:

```bash
bun x tsc --noEmit -p packages/cli
bun test packages/cli/src/commands/workflow.test.ts
```

Expected: no type errors; `buildDetachedRunCmd` tests still pass (they don't touch the spawn).

- [ ] **Step 4: (optional) lint the file.** `bun x eslint packages/cli/src/commands/workflow.ts` — expect clean.

---

## Task 2: Live verification — the real acceptance check

This is the actual test (the fix is a runtime process behavior). You need one `--detach` dispatch that provisions a worktree, because `worktree_creating` is exactly where it died before.

- [ ] **Step 1: Fire a detached run.** Any worktree-provisioning workflow works; the analytics plan is a fine throwaway (you'll abandon it once survival is proven):

```bash
gh auth switch --user buun-dev
env -u CLAUDECODE archon workflow run plan-to-pr-tdd \
  --cwd codebase/marphob-page --from feat/login-booking-redesign \
  --branch detach-smoketest --detach \
  "docs/superpowers/plans/2026-07-06-analytics-bookings-metric-clarity.md"
```

The command should return **immediately** and print a `detached-run-<conversationId>.log` path.

- [ ] **Step 2: Wait ~90s, then confirm the child SURVIVED past the death point.** Tail the newest detach log:

```bash
newest=$(ls -t ~/.archon/logs/detached-run-*.log | head -1); echo "$newest"; tail -20 "$newest"
```

**PASS** = the log continues well past `worktree_creating` (you'll see `worktree_created`, `bootstrap`, migrations, etc.). **FAIL** = it still stops dead at `worktree_creating` → go to Task 3.

- [ ] **Step 3: Corroborate via the run row.**

```bash
rid=$(archon workflow runs --json --limit 1 | grep -oE '"id":"[a-f0-9]+"' | head -1 | cut -d'"' -f4)
archon workflow get "$rid" --json | grep -E '"status"|"last_activity_at"'
```

PASS = `status: "running"` with a `last_activity_at` that keeps advancing on re-check.

- [ ] **Step 4: Stop the smoketest (don't waste a full build).** Once survival is confirmed, abandon it and clean up:

```bash
archon workflow abandon "$rid"
git -C codebase/marphob-page push origin --delete detach-smoketest 2>/dev/null || true
```

*(Or, if you'd rather get a second real PR out of it, just let it run to completion instead of abandoning.)*

---

## Task 3 (contingency — only if Task 2 still dies at ~1s)

If `detached: true` alone still dies, the launching shell is wrapping children in a **kill-on-close Job Object**, which `detached` doesn't break out of. Launch through Windows `start /b`, which spawns a truly independent background process. Replace the Task 1 spawn with a platform-branched version:

```ts
  try {
    let child;
    if (process.platform === 'win32') {
      // `cmd /c start "" /b` breaks the grandchild out of the parent's Job Object.
      child = spawn(
        'cmd.exe',
        ['/c', 'start', '""', '/b', cmd[0]!, ...cmd.slice(1)],
        {
          cwd,
          env: process.env,
          stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
          detached: true,
          windowsHide: true,
        }
      );
    } else {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd,
        env: process.env,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
        detached: true,
        windowsHide: true,
      });
    }
    child.unref();
  } finally {
```

Then re-run Task 2. Caveat: if any argv element contains spaces or special chars, the `start` form needs quoting — the analytics plan path has none, so the smoketest is safe; harden the quoting before relying on it broadly.

---

## Rollback

The edit is live, so reverting is instant:

```bash
git -C D:/Project/Archon-template checkout -- packages/cli/src/commands/workflow.ts
```

---

## Follow-up (after the fix verifies green)

- **Close the retro loop:** update the marphob-page vault dispatch guidance (`MarphobBrain/Memory/repositories/marphob-page.md`) — replace the contradictory `--detach`-is-flaky note (line ~341) with "`--detach` fixed 2026-07-07 (Bun.spawn→Node detached); use it, no more manual finishes," and mark `dispatch-shell-kill-breaks-bash-spawn` `status=mechanized` in `docs/retros/worked-failures.md`.
- **Upstream it:** this is a real Archon bug (`Bun.spawn` never detaches) — worth a PR/issue to the Archon repo so it's fixed for everyone, not just your local tree.

---

## Self-Review

- **Root cause is code-evidenced**, not guessed: the `Bun.spawn` call with no `detached`, plus a real detach log frozen at `worktree_creating` with no error.
- **Fix mirrors a proven in-repo pattern** (`setup.ts` uses Node `spawn(..., { detached: true })`), so it's low-risk and idiomatic for this codebase.
- **No rebuild step** because the tool runs from source (verified three ways: `.bunx` target, runtime stack-trace paths, no Windows build target).
- **The acceptance check is real and drivable** (a live `--detach` run past `worktree_creating`), not a fabricated unit test for un-testable OS behavior.
- **The Windows edge case is named with a concrete fallback** (Task 3), not hand-waved.
- **Blast radius honest:** changes `--detach` for all workflows; `buildDetachedRunCmd` and everything else untouched; rollback is one `git checkout`.
