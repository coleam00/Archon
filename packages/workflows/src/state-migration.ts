/**
 * One-time, non-destructive migration warning for the legacy repo-local
 * `.archon/state/` convention.
 *
 * `.archon/state/` was never an engine feature — no code ever computed that
 * path. Workflow prompts did `mkdir -p .archon/state` relative to cwd, which
 * meant that inside an isolated run the "cross-run memory" was written into the
 * WORKTREE and destroyed at cleanup, and in a user's repository it was fully
 * stageable (Archon never writes a `.gitignore`). `$STATE_DIR` replaces it with
 * an external per-project directory.
 *
 * Archon never moves the legacy directory: it detects, warns exactly once with a
 * copy-pasteable `mv`, and leaves the files alone. Mirrors
 * `maybeWarnLegacyHomePath()` in `workflow-discovery.ts`.
 */
import { access } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.state-migration');
  return cachedLog;
}

/**
 * Process-scoped so the warning fires exactly once regardless of how many runs
 * start. Exported reset so tests can observe more than the first case.
 */
let hasWarnedLegacyStatePath = false;
export function resetLegacyStateWarningForTests(): void {
  hasWarnedLegacyStatePath = false;
}

/**
 * Warn once if a legacy `<cwd>/.archon/state/` directory is present.
 *
 * `isolated` (the run's worktree posture) escalates the wording, and only the
 * wording: inside a worktree the legacy directory is about to be DELETED with
 * the worktree, which is the concrete data-loss bug `$STATE_DIR` exists to fix.
 * Worktree-ness discriminates the LEGACY path only — a worktree run that
 * correctly uses `$STATE_DIR` never reaches here, because there is no
 * `<cwd>/.archon/state` to find.
 *
 * Never moves, creates, or deletes anything.
 */
export async function maybeWarnLegacyStatePath(
  cwd: string,
  outputRoot: string,
  isolated: boolean
): Promise<void> {
  if (hasWarnedLegacyStatePath) return;
  // Set the flag eagerly so concurrent workflow starts in one process can't
  // both pass the guard and double-warn.
  hasWarnedLegacyStatePath = true;

  const legacyPath = join(cwd, '.archon', 'state');
  const newPath = join(outputRoot, 'state');
  try {
    await access(legacyPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return; // happy path — legacy location not in use
    // EACCES/EPERM/EIO: the directory exists but is unreadable. Surface at WARN
    // rather than swallowing — a silent debug would hide a real permission issue.
    getLog().warn({ err, legacyPath }, 'workflow.legacy_state_path_probe_error');
    return;
  }

  const moveCommand = `mv "${legacyPath}"/* "${newPath}"/`;
  const message = isolated
    ? 'Legacy .archon/state/ found inside an ISOLATED checkout — this directory is deleted with the worktree, ' +
      'so any cross-run state it holds is already being lost on every run. Move it to $STATE_DIR and switch the ' +
      'workflow to $STATE_DIR to make it durable.'
    : 'Legacy .archon/state/ found in the repository. Cross-run state belongs outside the repo — move it to ' +
      '$STATE_DIR and switch the workflow to $STATE_DIR. Nothing was moved automatically.';
  getLog().warn(
    { legacyPath, newPath, moveCommand, isolated, message },
    'workflow.legacy_state_path_detected'
  );
}
