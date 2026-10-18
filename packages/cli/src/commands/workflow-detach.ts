import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  getArchonHome,
  BUNDLED_IS_BINARY,
  expandTilde,
  isDocker,
  captureDetachedInstallContext,
  type DetachedInstallContext,
} from '@archon/paths';
import { join, resolve } from 'node:path';
import { mkdirSync, openSync, closeSync, readFileSync, writeSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine } from '../utils/stdout';
import { DETACHED_RUN_FAILED_EXIT_CODE } from '../utils/workflow-exit-code';
import { DETACHED_RUN_OWNER_ENV } from '../utils/detached-run-control';
import { getLog, printJsonWriteError, spelledForCli } from './workflow-shared';
import {
  DETACHED_RESUME_RECEIPT_ENV,
  DETACHED_RESUME_RECEIPT_FD,
  waitForDetachedResumeReceipt,
} from '../utils/detached-resume-receipt';

const DETACHED_STARTUP_WINDOW_MS = 500;
const DETACHED_LOG_TAIL_MAX_CHARS = 4_000;
const DETACHED_LOG_TAIL_MAX_LINES = 40;

function readDetachedLogTail(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf8');
    const lines = content.slice(-DETACHED_LOG_TAIL_MAX_CHARS).split('\n');
    const tail = lines.slice(-DETACHED_LOG_TAIL_MAX_LINES).join('\n').trim();
    return tail.length > 0 ? tail : null;
  } catch {
    return null;
  }
}

function detachedStartupExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  logPath: string | null
): Error {
  const reason = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${String(code)}`;
  const tail = logPath ? readDetachedLogTail(logPath) : null;
  const diagnostic = tail ? `\n\nChild output (${logPath}):\n${tail}` : '';
  return new Error(`Detached workflow child exited during startup with ${reason}.${diagnostic}`);
}

async function waitForDetachedStartup(
  child: ChildProcess,
  logPath: string | null,
  execPath: string,
  conversationId: string
): Promise<void> {
  const outcome = await new Promise<'completed' | 'failed' | 'survived'>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onStartupError);
    };
    const settle = (result: 'completed' | 'failed' | 'survived' | Error): void => {
      cleanup();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    // A child that is gone before the window closes either finished the run that fast or
    // never started it, and only the child can say which: `DETACHED_RUN_FAILED_EXIT_CODE`
    // is it reporting its run's own failure. Everything else non-zero is a death this
    // process could not have caused and the run cannot explain — a launch failure.
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code === 0) settle('completed');
      else if (code === DETACHED_RUN_FAILED_EXIT_CODE) settle('failed');
      else settle(detachedStartupExitError(code, signal, logPath));
    };
    const onStartupError = (error: Error): void => {
      settle(error);
    };
    const timer = setTimeout(() => {
      settle('survived');
    }, DETACHED_STARTUP_WINDOW_MS);

    child.once('exit', onExit);
    child.once('error', onStartupError);
  });

  if (outcome === 'survived') child.unref();
  getLog().debug(
    { execPath, conversationId, outcome, startupWindowMs: DETACHED_STARTUP_WINDOW_MS },
    'cli.detached_run_startup_acknowledged'
  );
}

/**
 * Build the argv for the detached re-invoke. Pure (no spawn / no process reads)
 * so both the dev (bun + entry script) and compiled-binary (execPath only)
 * branches are unit-testable — the binary branch is otherwise unreachable in
 * tests because `BUNDLED_IS_BINARY` is a module-level const. Drops `--detach`
 * and `--json` and appends `--cwd <cwd>` (last-wins) plus any extra flags.
 */
export function buildDetachedRunCmd(
  isBinary: boolean,
  execPath: string,
  argv: string[],
  cwd: string,
  extraArgs: string[]
): string[] {
  // Only the command prefix differs between modes: in a compiled binary
  // execPath IS the archon binary and re-invoking it needs no entry script; in
  // dev, execPath is bun and argv[1] is the cli entry that bun must be handed.
  const baseCmd = isBinary ? [execPath] : [execPath, argv[1]];
  // User args always start at argv[2] in BOTH modes. A Bun single-file
  // executable does have an argv[1] — the virtual entry path
  // (`/$bunfs/root/<name>`, `B:/~BUN/root/<name>.exe` on Windows) — so slicing
  // from 1 in binary mode leaked that path in as the child's first token and
  // the child died with `Unknown command: B:/~BUN/root/archon-...exe` (#2248).
  // cli.ts's own parser reads `process.argv.slice(2)` unconditionally, which is
  // the contract this must match.
  const userArgs: string[] = [];
  const supplied = argv.slice(2);
  for (let index = 0; index < supplied.length; index++) {
    const arg = supplied[index];
    if (arg === '--')
      return [...baseCmd, ...userArgs, '--cwd', cwd, ...extraArgs, ...supplied.slice(index)];
    if (arg === '--base-branch') {
      index++;
      continue;
    }
    if (arg.startsWith('--base-branch=') || arg === '--detach' || arg === '--json') continue;
    userArgs.push(arg);
  }
  // --cwd is appended last (parseArgs last-wins) so the child resolves the same
  // absolute working dir regardless of any relative --cwd the caller passed.
  return [...baseCmd, ...userArgs, '--cwd', cwd, ...extraArgs];
}

/** Freeze the install key context before a detached child changes cwd. */
export function resolveDetachedRunEncryptionEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): DetachedInstallContext {
  return {
    ...captureDetachedInstallContext(env),
    ARCHON_HOME: isDocker(env)
      ? getArchonHome(env)
      : env.ARCHON_HOME
        ? resolve(cwd, expandTilde(env.ARCHON_HOME))
        : '',
  };
}

export async function spawnDetachedWorkflowRun(
  cwd: string,
  conversationId: string,
  extraArgs: string[],
  runConfigPayload?: string,
  confirmResume = false
): Promise<string | null> {
  const cmd = buildDetachedRunCmd(
    BUNDLED_IS_BINARY,
    process.execPath,
    process.argv,
    cwd,
    runConfigPayload
      ? [...extraArgs, '--internal-detached-run-config', runConfigPayload]
      : extraArgs
  );

  let logPath: string | null = null;
  let logFd: number | undefined;
  try {
    const logDir = join(getArchonHome(), 'logs');
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, `detached-run-${conversationId}.log`);
    logFd = openSync(logPath, 'a');
    writeSync(
      logFd,
      `\n--- detached workflow invocation: ${conversationId} at ${new Date().toISOString()} ---\n`
    );
  } catch (error) {
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        /* fd already closed/invalid — nothing to clean up */
      }
    }
    getLog().warn({ err: error as Error }, 'cli.detached_run_log_open_failed');
    logPath = null;
    logFd = undefined;
  }

  try {
    // Node's spawn with `detached: true` puts the child in its own process
    // group so it survives the parent's exit. Bun.spawn + unref() does NOT
    // detach on Windows — the child was killed ~1s in (at worktree_creating)
    // when the launching shell/console tore down. `detached: true` is the
    // standard fix, also used by setup-spawn.ts's trySpawn(); if a kill-on-close Job
    // Object wrapper ever defeats it, a `start /b` breakaway fallback is the
    // next step. `windowsHide` keeps the child headless.
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: {
        ...process.env,
        [DETACHED_RUN_OWNER_ENV]: '1',
        [DETACHED_RESUME_RECEIPT_ENV]: confirmResume ? '1' : '',
        ...(runConfigPayload
          ? {
              // Empty strings preserve meaningful absence: Bun will not fill
              // these from the target repo's auto-loaded .env.
              ...resolveDetachedRunEncryptionEnv(),
            }
          : {}),
      },
      stdio: [
        'ignore',
        logFd ?? 'ignore',
        logFd ?? 'ignore',
        ...(confirmResume ? ['pipe' as const] : []),
      ],
      detached: true,
      windowsHide: true,
    });
    // Unlike Bun.spawn, Node's spawn does NOT throw synchronously on a bad
    // executable or cwd — the failure arrives as an async 'error' event, which
    // would crash the CLI as an uncaught exception without this listener.
    child.on('error', (error: Error) => {
      getLog().error(
        { err: error, execPath: cmd[0], conversationId },
        'cli.detached_run_spawn_failed'
      );
    });
    // pid is set synchronously iff the OS-level spawn succeeded (same check as
    // setup-spawn.ts's trySpawn) — fail fast instead of acking a run that never started.
    if (child.pid === undefined) {
      throw new Error(`Failed to start detached workflow child (executable: ${cmd[0]})`);
    }
    if (confirmResume) {
      const pipe = child.stdio[DETACHED_RESUME_RECEIPT_FD];
      if (!pipe || !('readable' in pipe)) {
        child.unref();
        throw new Error('Detached resume acceptance pipe was not created.');
      }
      try {
        await waitForDetachedResumeReceipt(child, pipe, (code, signal) =>
          detachedStartupExitError(code, signal, null)
        );
      } catch (error) {
        const tail = logPath ? readDetachedLogTail(logPath) : null;
        throw new Error(
          `Detached resume acceptance was not confirmed. ${error instanceof Error ? error.message : String(error)}` +
            (logPath ? `\nChild output (${logPath}):\n${tail ?? '(no output recorded)'}` : ''),
          { cause: error }
        );
      }
    } else {
      await waitForDetachedStartup(child, logPath, cmd[0], conversationId);
    }
  } finally {
    // The child inherits its own dup of the log fd; close the parent's copy so a
    // synchronous spawn failure (bad execPath, invalid cwd) doesn't leak it.
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        /* fd already closed/invalid — nothing to clean up */
      }
    }
  }
  return logPath;
}

/**
 * Record why a handed-over run never started (#2872).
 *
 * A detached child is given a row its launcher already created, and everything between
 * that handover and the executor taking over — project resolution, the live re-check of
 * an adoption, isolation — can throw. The launcher is long gone by then, so without this
 * the row sits `pending` forever while the reason exists only in the child's log: the
 * same silent failure this issue closed at launch, moved one process later.
 *
 * `pending` is the whole guard, and it is what keeps this from guessing at a lifecycle
 * it does not own: the executor flips the row to `running` before any node executes, so
 * a row still `pending` here is one no execution ever claimed. Anything else belongs to
 * the run and is left alone — `failWorkflowRun`'s own status CAS closes the race.
 */
export async function recordDetachedChildStartupFailure(
  host: WorkflowHost,
  detachedRunId: string | undefined,
  error: Error
): Promise<void> {
  if (detachedRunId === undefined) return;
  try {
    const status = await host.deps.store.getWorkflowRunStatus(detachedRunId);
    if (status !== 'pending') return;
    await host.deps.store.failWorkflowRun(
      detachedRunId,
      `Detached run failed to start: ${error.message}`,
      { exitReason: 'launch_failed' }
    );
  } catch (dbError) {
    getLog().error(
      { err: dbError as Error, workflowRunId: detachedRunId },
      'cli.detached_startup_failure_record_failed'
    );
  }
}

/**
 * Shared `--detach` front half for `approve`/`reject`/`resume`. Validates the run
 * READ-ONLY via `precheck`, then hands the whole command to a detached child that
 * re-invokes the same argv (minus `--detach`/`--json`) and owns ALL state mutation
 * in its own process group — so killing the shell that hosted the parent cannot
 * zombie the run mid-resume. The parent must never call
 * approveWorkflow/rejectWorkflow/resumeWorkflow itself, or the decision would be
 * recorded twice (mirrors workflowRunCommand's detach shape: the parent does nothing).
 *
 * Spawns with the command's `cwd` (falling back to `process.cwd()`), never the run's
 * working_path: the child re-resolves everything by run-id, and a container run's
 * working_path is a distro path the host cannot spawn into (ENOENT → the detach would
 * silently no-op). Reuses upstream's spawnDetachedWorkflowRun, which rebuilds the child
 * command from process.argv. Resume success requires engine admission; the other verbs
 * retain the startup window (#2279). Awaiting that boundary keeps a launch failure from
 * arriving after the parent has already printed `{ ok: true }`.
 */
export async function runDetachedControlCommand(
  runId: string,
  action: 'approve' | 'reject' | 'respond' | 'resume',
  json: boolean | undefined,
  cwd: string | undefined,
  precheck: () => Promise<WorkflowRun>
): Promise<number> {
  try {
    const run = await spelledForCli(precheck);
    // The caller's --cwd, already resolved by cli.ts — NOT process.cwd(). The
    // appended --cwd is last-wins on the child's argv, so discarding it here
    // strands the child in the parent's directory (possibly outside any git
    // repo) after the parent has already acked success. The run's working_path
    // is still never a candidate: a container run's working_path is a distro
    // path the host cannot spawn into, so the child re-resolves by run id.
    const logPath = await spawnDetachedWorkflowRun(
      cwd ?? process.cwd(),
      runId,
      [],
      undefined,
      action === 'resume'
    );
    if (json) {
      // Through writeJsonLine, like every other --json ack: it writes with a
      // completion callback so a piped consumer can't receive a truncated
      // document (#2384). console.log does not give that guarantee.
      await writeJsonLine({
        ok: true,
        runId,
        action,
        detached: true,
        // The child is spawned WITHOUT --json (buildDetachedRunCmd strips it),
        // so it takes the inline path and DRIVES THE RUN ONWARD — approve's
        // auto-resume, reject's on_reject rework, resume's re-run. This is the
        // opposite of bare `--json`, which withholds continuation on purpose.
        // Surfaced so an automation knows it does not own continuation here.
        continues: true,
        workflowName: run.workflow_name,
        // null when the log file could not be opened — the child still runs, but
        // its output is discarded. Same contract as `run --detach`.
        logPath,
      });
      return 0;
    }
    console.log(`Started '${action}' for run ${runId} in the background.`);
    console.log(`Track it with: archon workflow get ${runId}`);
    if (logPath) {
      console.log(`Child output: ${logPath}`);
    } else {
      // Mirrors `run --detach`: with no log file the child's output is discarded,
      // so a failure after the startup window leaves no trail to read.
      console.warn('Warning: could not open a log file — child output will not be captured.');
    }
  } catch (error) {
    // Precheck failures follow each mode's error contract: --json emits the
    // standard { ok: false } line; human mode throws like the inline path.
    if (json) {
      await printJsonWriteError(runId, action, error);
      return 1;
    }
    throw error;
  }
  return 0;
}
