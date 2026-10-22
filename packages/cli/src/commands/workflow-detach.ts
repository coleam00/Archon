import { DETACHED_LAUNCH_METADATA_KEY } from '@archon/workflows/store';
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
import * as archonPaths from '@archon/paths';
import type { Codebase } from '@archon/core/schemas/codebase';
import { sealWorkflowRunConfig } from '@archon/core/config';
import { RUN_AI_CONFIGURATION_METADATA_KEY } from '@archon/workflows/run-ai-configuration';
import { WORKFLOW_RUN_CONFIG_METADATA_KEY } from '@archon/workflows/run-config';
import type { PreparedRunAiConfiguration } from '@archon/workflows/run-preflight';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import {
  CONTINUATION_METADATA_KEY,
  SUBRUN_METADATA_KEYS,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { writeJsonLine } from '../utils/stdout';
import { DETACHED_RUN_FAILED_EXIT_CODE } from '../utils/workflow-exit-code';
import { DETACHED_LAUNCH_TOKEN_ENV, DETACHED_RUN_OWNER_ENV } from '../utils/detached-run-control';
import { RUN_JOB_ESCAPE_BUN_CONFIG_ARG } from '../utils/run-job-escape';
import {
  destinationCorrelationId,
  getLog,
  printJsonWriteError,
  resolveRunTranscriptPath,
  spelledForCli,
  type RunDestination,
  type WorkflowRunOptions,
} from './workflow-shared';
import {
  buildNoResumableRunError,
  buildResumeLookupFailureError,
  type ContinuationDeclaration,
} from './workflow-run-preflight';
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
  extraArgs: string[],
  execArgv: readonly string[] = []
): string[] {
  // The escape broker disables project startup hooks with an explicit Bun config.
  // Keep only that cwd-independent config; caller config paths belong to the launch cwd.
  const baseCmd = isBinary
    ? [execPath]
    : [execPath, ...execArgv.filter(arg => arg === RUN_JOB_ESCAPE_BUN_CONFIG_ARG), argv[1]];
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
  confirmResume = false,
  launchToken = ''
): Promise<string | null> {
  const cmd = buildDetachedRunCmd(
    BUNDLED_IS_BINARY,
    process.execPath,
    process.argv,
    cwd,
    runConfigPayload
      ? [...extraArgs, '--internal-detached-run-config', runConfigPayload]
      : extraArgs,
    process.execArgv
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
        [DETACHED_LAUNCH_TOKEN_ENV]: launchToken,
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
 * The launch token binds the row even when process-container setup or admission threw.
 * Only pending rows belong to startup; running and terminal rows belong to the
 * executor and are left alone.
 */
export async function recordDetachedChildStartupFailure(
  host: WorkflowHost,
  request: {
    detachedRunId: string | undefined;
    detachedProcessOwner: boolean;
    launchToken: string | undefined;
  },
  error: Error
): Promise<void> {
  const { detachedRunId, detachedProcessOwner, launchToken } = request;
  if (detachedRunId === undefined || !detachedProcessOwner || !launchToken) return;
  try {
    await host.deps.store.failWorkflowRun(
      detachedRunId,
      `Detached run failed to start: ${error.message}`,
      { exitReason: 'launch_failed', pendingLaunchToken: launchToken }
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

/** What a `--detach` launch needs once its pre-flight has passed. */
export interface DetachedLaunch {
  host: WorkflowHost;
  cwd: string;
  workflowName: string;
  userMessage: string;
  options: WorkflowRunOptions;
  workflow: ResolvedWorkflow;
  isContinuation: boolean;
  continuationRun: WorkflowRun | undefined;
  resumeLookupError: Error | undefined;
  cliUserId: string | undefined;
  codebase: Codebase | null;
  isFolder: boolean;
  wantsIsolation: boolean;
  destination: RunDestination;
  declaration: Pick<ContinuationDeclaration, 'mode' | 'runId'> | undefined;
  prepared: PreparedRunAiConfiguration;
  resolvedInputs: Record<string, string> | undefined;
  runConfig: WorkflowRunConfigInput | undefined;
}

/** The run id the ack hands back, and the row this process wrote for it, if any. */
interface DetachedRunClaim {
  detachedRunId: string;
  /**
   * Only a row THIS process created may be failed when the child never takes it.
   * A continuation's row belongs to its own run.
   */
  launchedRunId?: string;
  launchToken?: string;
}

/**
 * Write a fresh launch's run row, fork the detached child and print its ack. A continuation
 * hands the child its existing run instead of writing a row.
 */
export async function launchDetachedRun(launch: DetachedLaunch): Promise<void> {
  const { host, cwd, runConfig, destination: childDestination } = launch;
  const claim = await claimDetachedRun(launch);
  const { extraArgs, pinnedBranch } = buildDetachedChildArgs(launch, claim.launchedRunId);
  const transcriptPath = await resolveDetachedTranscriptPath(launch, claim.detachedRunId);
  const runConfigPayload = runConfig
    ? JSON.stringify(sealWorkflowRunConfig(runConfig.layer, runConfig.source))
    : undefined;
  let logPath: string | null;
  try {
    logPath = await spawnDetachedWorkflowRun(
      cwd,
      destinationCorrelationId(childDestination),
      extraArgs,
      runConfigPayload,
      false,
      claim.launchToken
    );
  } catch (error) {
    // The child never took the run — it failed to spawn, or died inside the startup
    // window. This process is the row's only owner until the child claims it, so it
    // records why instead of leaving a `pending` row nobody can explain.
    const launchedRunId = claim.launchedRunId;
    if (launchedRunId !== undefined) {
      await host.deps.store
        .failWorkflowRun(launchedRunId, `Detached launch failed: ${(error as Error).message}`, {
          exitReason: 'launch_failed',
        })
        .catch((dbError: Error) => {
          getLog().error(
            { err: dbError, workflowRunId: launchedRunId },
            'cli.detached_launch_failure_record_failed'
          );
        });
    }
    throw error;
  }
  await printDetachedLaunchAck(launch, {
    detachedRunId: claim.detachedRunId,
    pinnedBranch,
    transcriptPath,
    logPath,
  });
}

/** A continuation already has its run id; a fresh launch gets a row written here, before the fork. */
async function claimDetachedRun(launch: DetachedLaunch): Promise<DetachedRunClaim> {
  const {
    host,
    cwd,
    workflowName,
    userMessage,
    workflow,
    continuationRun,
    resumeLookupError,
    cliUserId,
    codebase: detachCodebase,
    prepared: detachedPrepared,
    resolvedInputs,
    declaration: continuationDeclaration,
  } = launch;
  if (launch.isContinuation) {
    if (resumeLookupError) throw buildResumeLookupFailureError(resumeLookupError);
    if (!continuationRun) throw buildNoResumableRunError(workflowName, cwd);
    return { detachedRunId: continuationRun.id };
  }
  // `Started` must mean a queryable run, so the row is written before the fork and
  // the child executes it rather than creating its own. Modeled on the
  // orchestrator's pre-created row (dispatchBackgroundWorkflowOwned), including
  // the stamps the executor only writes when IT creates the row. `working_path` is
  // the one field this process cannot know — the child cuts the worktree — so it
  // stays null until the child fills it in (write-once in the store).
  try {
    // No reserved id: this process's own capture is discarded on the way out, and
    // reusing its id would point the child's capture at a directory this process is
    // about to reclaim. The row's generated id is what the child files under.
    const launchToken = crypto.randomUUID();
    const created = await host.deps.store.createWorkflowRun({
      workflow_name: workflow.name,
      origin: {
        userId: cliUserId,
      },
      ...(detachCodebase ? { codebase_id: detachCodebase.id } : {}),
      user_message: userMessage,
      metadata: {
        [DETACHED_LAUNCH_METADATA_KEY]: launchToken,
        [RUN_AI_CONFIGURATION_METADATA_KEY]: detachedPrepared.aiConfigurationSnapshot,
        ...(detachedPrepared.runConfigMetadata
          ? { [WORKFLOW_RUN_CONFIG_METADATA_KEY]: detachedPrepared.runConfigMetadata }
          : {}),
        // Declared inputs (#2554): `$INPUTS` is read off the row, so a pre-created
        // row that omits them starts a run whose inputs silently disappeared.
        ...(resolvedInputs && Object.keys(resolvedInputs).length > 0
          ? { [SUBRUN_METADATA_KEYS.inputs]: { ...resolvedInputs } }
          : {}),
        ...(continuationDeclaration
          ? { [CONTINUATION_METADATA_KEY]: { mode: continuationDeclaration.mode } }
          : {}),
      },
      ...(continuationDeclaration ? { adopted_from_run_id: continuationDeclaration.runId } : {}),
    });
    return { detachedRunId: created.id, launchedRunId: created.id, launchToken };
  } catch (error) {
    throw new Error(
      `Failed to create the workflow run: ${(error as Error).message}\nNothing was started.`
    );
  }
}

/** The arguments the child gets on top of this process's argv. */
function buildDetachedChildArgs(
  launch: DetachedLaunch,
  launchedRunId: string | undefined
): { extraArgs: string[]; pinnedBranch: string | undefined } {
  const {
    workflowName,
    options,
    wantsIsolation,
    isFolder: detachIsFolder,
    destination: childDestination,
    declaration,
  } = launch;
  const adoptedRunId = declaration?.mode === 'adopt' ? declaration.runId : undefined;
  const supersededRunId = declaration?.mode === 'supersede' ? declaration.runId : undefined;
  const extraArgs: string[] = [];
  let pinnedBranch: string | undefined;
  // Pin identity after name resolution so a rename cannot redirect the child.
  if (!launch.isContinuation && options.codebaseId && launch.codebase) {
    extraArgs.push('--project', launch.codebase.id);
  }
  // Pin a generated branch only when isolating AND the caller didn't pass
  // --branch (an explicit --branch is already in argv). Without this, the child
  // would generate its own timestamped branch and fork a second worktree.
  // Never pin a branch for folder projects — they run in place with no worktree.
  if (
    wantsIsolation &&
    !detachIsFolder &&
    options.branchName === undefined &&
    options.adoptRunId === undefined
  ) {
    pinnedBranch = `${workflowName}-${String(Date.now())}`;
    extraArgs.push('--branch', pinnedBranch);
  }
  // A continued chat run retains its transport thread across the fork.
  if (options.conversationId === undefined && childDestination.kind === 'conversation') {
    extraArgs.push('--conversation-id', destinationCorrelationId(childDestination));
  }
  // Between-run continuation (#2747) — the child re-resolves the adoption
  // against the live filesystem/database, so pass the declaration through.
  if (adoptedRunId !== undefined) extraArgs.push('--adopt', adoptedRunId);
  if (supersededRunId !== undefined) extraArgs.push('--supersedes', supersededRunId);
  // Re-pin the source as an ABSOLUTE path (parseArgs is last-wins, same as --cwd).
  // The original argv may hold a relative `--workflow-source`, and the child is
  // spawned with a different working directory, so passing it through unresolved
  // would silently point the child at another directory — or at nothing.
  if (options.discoveryCwd !== undefined) {
    extraArgs.push('--workflow-source', options.discoveryCwd);
  }
  // Only a row THIS process created is handed over: the child executes it and files
  // its own source capture under that id, so the row and the capture still agree. A
  // continuation resolves its own run by the id already in the child's argv. This
  // process's capture is dead weight — never adopted, so the owner reclaims it on the
  // way out.
  if (launchedRunId !== undefined) {
    extraArgs.push('--internal-detached-run-id', launchedRunId);
  }
  return { extraArgs, pinnedBranch };
}

async function resolveDetachedTranscriptPath(
  launch: DetachedLaunch,
  detachedRunId: string
): Promise<string | null> {
  const {
    host,
    cwd,
    workflowName,
    isContinuation,
    continuationRun,
    codebase: detachCodebase,
  } = launch;
  let transcriptPath: string | null;
  if (isContinuation) {
    if (!continuationRun) throw buildNoResumableRunError(workflowName, cwd);
    try {
      transcriptPath = await resolveRunTranscriptPath(host, continuationRun);
    } catch (error) {
      transcriptPath = null;
      getLog().warn(
        { err: error as Error, workflowRunId: detachedRunId },
        'cli.detached_transcript_path_resolve_failed'
      );
    }
  } else {
    try {
      const storage = archonPaths.getProjectStoragePaths(
        archonPaths.resolveProjectStorageKey(detachCodebase, cwd)
      );
      transcriptPath = archonPaths.getRunLogPathForRoot(storage.root, detachedRunId);
    } catch (error) {
      transcriptPath = null;
      getLog().warn(
        { err: error as Error, workflowRunId: detachedRunId },
        'cli.detached_transcript_path_resolve_failed'
      );
    }
  }
  return transcriptPath;
}

async function printDetachedLaunchAck(
  launch: DetachedLaunch,
  ack: {
    detachedRunId: string;
    pinnedBranch: string | undefined;
    transcriptPath: string | null;
    logPath: string | null;
  }
): Promise<void> {
  const { options, workflow, destination: childDestination } = launch;
  const { detachedRunId, pinnedBranch, transcriptPath, logPath } = ack;
  if (options.json) {
    await writeJsonLine({
      ok: true,
      action: 'run',
      detached: true,
      // The handle the launch promised (#2872). Its row already exists, so a caller
      // can query or wait on it without polling for the run to appear.
      runId: detachedRunId,
      workflow: workflow.name,
      branch: pinnedBranch ?? options.branchName ?? null,
      conversationId:
        childDestination.kind === 'conversation'
          ? destinationCorrelationId(childDestination)
          : null,
      transcriptPath,
      logPath,
    });
  } else {
    console.log(`Started '${workflow.name}' in the background.`);
    console.log(`Run id: ${detachedRunId}`);
    console.log(`Track it with: archon workflow get ${detachedRunId}`);
    console.log(`Transcript: ${transcriptPath ?? '(unavailable)'}`);
    if (logPath) {
      console.log(`Child output: ${logPath}`);
    } else {
      // Log file couldn't be opened — the child runs with its output discarded, so a
      // failure after the startup window leaves no trail beyond the run row itself.
      console.warn('Warning: could not open a log file — child output will not be captured.');
    }
  }
}
