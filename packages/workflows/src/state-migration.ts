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
 * Which working directories have already been probed in this process.
 *
 * Keyed by `cwd`, NOT a single process-wide boolean: the probed path is
 * per-project (`<cwd>/.archon/state`), so a global latch would let the first run
 * in a process — any project, legacy directory or not — permanently suppress
 * detection for every other project. On a server handling many codebases (the
 * normal deployment shape) that means the check effectively never fires, and
 * this WARN is the only automatic signal a user gets that cross-run state inside
 * a worktree is being destroyed on every run.
 *
 * (The pattern was adapted from `maybeWarnLegacyHomePath` in
 * `workflow-discovery.ts`, where a process-wide latch IS correct because that
 * function probes one fixed, cwd-independent path.)
 *
 * Exported reset so tests can observe more than the first case per cwd.
 */
const warnedCwds = new Set<string>();
/** Deduplicates concurrent probes of the same cwd without latching the result. */
const inFlightProbes = new Map<string, Promise<void>>();
export function resetLegacyStateWarningForTests(): void {
  warnedCwds.clear();
  inFlightProbes.clear();
}

/**
 * Warn once per working directory if a legacy `<cwd>/.archon/state/` directory
 * is present.
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
  stateDir: string,
  isolated: boolean
): Promise<void> {
  // Latched only once this cwd has actually produced a warning. Latching before
  // the probe would let a cwd with NO legacy directory consume its own latch, so
  // a legacy directory created later in the same process would never be
  // reported for that cwd again.
  if (warnedCwds.has(cwd)) return;

  // Concurrent starts on the same cwd share one probe rather than each running
  // their own — that is what the pre-probe latch was really buying, and an
  // in-flight promise buys it without swallowing future probes.
  const existing = inFlightProbes.get(cwd);
  if (existing) return existing;

  const probe = probeLegacyStatePath(cwd, stateDir, isolated).finally(() => {
    inFlightProbes.delete(cwd);
  });
  inFlightProbes.set(cwd, probe);
  return probe;
}

/**
 * Warn once per working directory if a legacy `<cwd>/.archon/artifacts/` or
 * `<cwd>/.archon/logs/` directory is present (#2311).
 *
 * The asymmetry this closes: `.archon/state/` was a prompt convention the engine
 * never created, and it got a detector. These two the ENGINE itself created, on
 * the unregistered-cwd fallback — and they got nothing, so the relocation of the
 * case Archon actually caused was the silent one.
 *
 * Deliberately a WARN and not a migration. For an isolated run `cwd` IS the
 * worktree, so those artifacts already died at teardown and there is nothing to
 * move. The persistent case is a run executed in place, and there the files are
 * sitting in the user's own repository — unlinked from the console, not deleted.
 * That does not justify a migration tool; it justifies saying so once.
 *
 * Latched separately from the state probe: a repo can have one and not the other,
 * and a shared latch would let whichever fired first hide the other forever.
 *
 * Never moves, creates, or deletes anything.
 */
export async function maybeWarnLegacyArtifactsPath(
  cwd: string,
  artifactsRoot: string,
  isolated: boolean
): Promise<void> {
  const latchKey = `artifacts:${cwd}`;
  if (warnedCwds.has(latchKey)) return;

  const existing = inFlightProbes.get(latchKey);
  if (existing) return existing;

  const probe = probeLegacyArtifactsPath(cwd, artifactsRoot, isolated, latchKey).finally(() => {
    inFlightProbes.delete(latchKey);
  });
  inFlightProbes.set(latchKey, probe);
  return probe;
}

async function probeLegacyArtifactsPath(
  cwd: string,
  artifactsRoot: string,
  isolated: boolean,
  latchKey: string
): Promise<void> {
  const legacyArtifacts = join(cwd, '.archon', 'artifacts');
  const legacyLogs = join(cwd, '.archon', 'logs');

  const found: string[] = [];
  for (const path of [legacyArtifacts, legacyLogs]) {
    try {
      await access(path);
      found.push(path);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue; // happy path — legacy location not in use
      // Exists but unreadable. Surface rather than swallow, and latch so an
      // unreadable directory does not re-probe on every run of this cwd.
      warnedCwds.add(latchKey);
      getLog().warn({ err, legacyPath: path }, 'workflow.legacy_artifacts_path_probe_error');
      return;
    }
  }
  if (found.length === 0) return;

  warnedCwds.add(latchKey);

  // No `mv` offered. Unlike the state case there is no single correct destination:
  // artifacts are keyed per RUN under the new tree, so a bulk move would flatten
  // runs together. Point at the directory and let the operator decide.
  const message = isolated
    ? 'Legacy .archon/artifacts|logs found inside an ISOLATED checkout. These predate the external output ' +
      'tree and are deleted with the worktree, so nothing is lost by the relocation — new runs write under ' +
      '~/.archon and are browsable in the console.'
    : 'Legacy .archon/artifacts|logs found in the repository. New runs write under ~/.archon instead, so ' +
      'output from runs that predate the upgrade is still on disk here but no longer listed in the console. ' +
      'Nothing was moved or deleted.';
  getLog().warn(
    { legacyPaths: found, newPath: artifactsRoot, isolated, message },
    'workflow.legacy_artifacts_path_detected'
  );
}

async function probeLegacyStatePath(
  cwd: string,
  stateDir: string,
  isolated: boolean
): Promise<void> {
  const legacyPath = join(cwd, '.archon', 'state');
  // Taken from the centralized resolver rather than re-composed here, so this
  // file holds no hard-coded knowledge of the tree layout.
  const newPath = stateDir;
  try {
    await access(legacyPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return; // happy path — legacy location not in use
    // EACCES/EPERM/EIO: the directory exists but is unreadable. Surface at WARN
    // rather than swallowing — a silent debug would hide a real permission issue.
    warnedCwds.add(cwd);
    getLog().warn({ err, legacyPath }, 'workflow.legacy_state_path_probe_error');
    return;
  }

  // A definitive detection — latch so later runs on this cwd stay quiet.
  warnedCwds.add(cwd);

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
