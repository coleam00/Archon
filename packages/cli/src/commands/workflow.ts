/**
 * Workflow command - list and run workflows
 */
import { existsSync, readdirSync, type Dirent } from 'node:fs';
import * as archonPaths from '@archon/paths';
import {
  registerRepository,
  registerFolder,
  loadConfig,
  loadRepoConfig,
  generateAndSetTitle,
  createWorkflowStore,
  getUserAiPrefs,
  isPerUserGitHubEnabled,
  getDecryptedAccessToken,
} from '@archon/core';
import {
  loadWorkflowRunConfigFile,
  normalizeRunConfigSemantics,
  sealWorkflowRunConfig,
} from '@archon/core/config';
import { WORKFLOW_EVENT_TYPES, type WorkflowEventType } from '@archon/workflows/store';
import {
  isTierName,
  applyResolvedRunModelOverrides,
  buildAiProfile,
  parseRunModelAssignments,
  resolveRunModelOverrides,
  TIER_NAMES,
  type BuildAiProfileOptions,
  type ResolvedAiProfile,
  type TierName,
  type RawTiersConfig,
} from '@archon/workflows/model-validation';
import {
  configureIsolation,
  getIsolationProvider,
  resolveFolderBackend,
  classifyIsolationError,
} from '@archon/isolation';
import type { ExecutionContext, ContainerBackend, ContainerBackendConfig } from '@archon/isolation';
import type { TaskBranchSelection } from '@archon/isolation';
import {
  createLogger,
  getArchonHome,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  readTierNoticeState,
  markTierNoticeShown,
  expandTilde,
  isDocker,
  captureDetachedInstallContext,
  type DetachedInstallContext,
} from '@archon/paths';
import { isAbsolute, join, resolve } from 'node:path';
import { applyWorkflowRunConfigLayer } from '@archon/workflows/run-config';
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { createChildWorktreeResolver } from '@archon/core/workflows/child-isolation-resolver';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { reclaimContainerEnv } from '@archon/core/services/cleanup-service';
import { waitForRunAttention } from '@archon/core/services/run-attention-watch';
import type { RunWaitResult } from '@archon/core/services/run-attention-watch';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import {
  executeWorkflow,
  disposeWorkflowSource,
  finalizeWorkflowSource,
  hydrateResumableRun,
  prepareWorkflowSource,
  recordSelectedWorkflow,
  resolveContinuationWorkflow,
  withCapturedSource,
  workflowSourceConfigFrom,
  type CapturedSourceOwner,
  type PreparedWorkflowSource,
  type ResolvedContinuation,
} from '@archon/workflows/executor';
import {
  assertComposedGateDriveable,
  assertInteractiveClassNotBackgrounded,
  assertWorkflowRequirementsMet,
  resolveTopLevelInputs,
} from '@archon/workflows/utils/workflow-requirements';
import { parseInputAssignments } from '@archon/workflows/workflow-inputs';
import { formatDeprecationNotice } from '@archon/workflows/deprecation';
import {
  dryRunWorkflow,
  formatDryRunTrace,
  loadDryRunStubs,
  writeDryRunStubScaffold,
} from '@archon/workflows/dry-run';
import { formatFixtureReport, runFixtures } from '@archon/workflows/fixture-runner';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type {
  DeclaredWorkflowConfig,
  WorkflowDefinition,
  WorkflowLoadResult,
  WorkflowSource,
  WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import type { DagNode } from '@archon/workflows/schemas/dag-node';
import type { WorkflowRunConfigInput } from '@archon/workflows/schemas/run-config';
import {
  workflowRunStatusSchema,
  isApprovalContext,
  isWorkflowWaitContext,
  isScheduledWorkflowResume,
  SUBRUN_METADATA_KEYS,
  CONTINUATION_METADATA_KEY,
} from '@archon/workflows/schemas/workflow-run';
import type {
  WorkflowRun,
  WorkflowRunStatus,
  ContinuationMode,
} from '@archon/workflows/schemas/workflow-run';
import { TERMINAL_WORKFLOW_STATUSES } from '@archon/workflows/schemas/workflow-run';
import {
  approveWorkflow,
  rejectWorkflow,
  respondToWorkflow,
  resumeWorkflow as resumeWorkflowOp,
  abandonWorkflow,
  getWorkflowStatus,
  resetWorkflowNodeSessions,
  assertApprovable,
  assertRejectable,
  assertRespondable,
} from '@archon/core/operations/workflow-operations';
import { resolveWorkflowAdoption } from '@archon/core/operations/workflow-adoption';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as messageDb from '@archon/core/db/messages';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';
import * as userDb from '@archon/core/db/users';
import * as git from '@archon/git';
import { CLIAdapter } from '../adapters/cli-adapter';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';
import { exitWithDrain } from '../utils/exit-with-drain';
import { DETACHED_RUN_FAILED_EXIT_CODE, WorkflowRunFailedError } from '../utils/workflow-exit-code';
export {
  DETACHED_RUN_FAILED_EXIT_CODE,
  WorkflowRunFailedError,
  resolveCliExitCode,
} from '../utils/workflow-exit-code';
import {
  assertDetachedRunProcessOwner,
  DETACHED_RUN_OWNER_ENV,
  requestDetachedRunStop,
  startDetachedRunControlServer,
} from '../utils/detached-run-control';
import { resolveCliUserId } from './auth';
import { RESUME_RUN_CONFIG_CONFLICT } from '../dispatch-guards';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.workflow');
  return cachedLog;
}

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
 * Options for workflow run command
 *
 * Default: creates worktree with auto-generated branch name (isolation by default).
 * --branch: explicit branch name for the worktree.
 * --no-worktree: opt out of isolation, run in live checkout.
 * --resume: reuse worktree from last failed run.
 * --from: override base branch (start-point for worktree).
 * --base: per-dispatch PR base + worktree cut-from override (wins over config).
 *
 * Mutually exclusive: --branch + --no-worktree, --resume + --branch,
 * --base + --no-worktree.
 */
export interface WorkflowRunOptions {
  branchName?: string;
  fromBranch?: string;
  /**
   * Per-dispatch base-branch override (`--base <branch>`). Wins over repo config
   * and the codebase default for BOTH the worktree cut-from and the PR target
   * (`$BASE_BRANCH`). Mutually exclusive with `--no-worktree`.
   */
  baseBranch?: string;
  noWorktree?: boolean;
  /**
   * Register the current non-git cwd as a folder project on first use and run
   * in place (no worktree isolation). No-op when the cwd is already a registered
   * project or a git repository.
   */
  folder?: boolean;
  /**
   * Run a FOLDER project inside the container isolation backend instead of
   * in-place. Flag beats workflow `container.enabled`, which beats config
   * `container.enabled` (default off). A repo-kind project + `--container` is a
   * hard error (container isolation is folder-only in v1).
   */
  container?: boolean;
  resume?: boolean;
  codebaseId?: string; // Skips path-based codebase lookup when resume/approve/reject already resolved it
  /**
   * Override the directory used for workflow YAML discovery — and, for a fresh run,
   * the source the run captures.
   *
   * Pass `codebase.default_cwd` here so the source repo is searched even when
   * `working_path` is a worktree or workspace clone that lacks the file. The public
   * `--workflow-source <path>` flag sets the same field, which is why one concept
   * covers both the internal resume/approve lookups and the user-facing split.
   */
  discoveryCwd?: string;
  /**
   * The run being continued, when this invocation continues one.
   *
   * Resume, approve, and reject re-enter through this command, and they must execute the
   * source the run FROZE — a workflow that lives only in the authoring checkout is not in
   * the target at all, and even when it is, re-discovering live resumes the run against a
   * different graph. The whole run is passed, not just its capture path, because
   * `resolveContinuationWorkflow` needs the recorded digest to verify against.
   *
   * Optional because `run <name> --resume` names the run indirectly; that form resolves the
   * row itself, before discovery, and joins the same path. `resume` alone therefore never
   * means live discovery.
   */
  continuationRun?: WorkflowRun;
  quiet?: boolean;
  verbose?: boolean;
  /** Platform conversation ID (e.g. `cli-{ts}-{rand}`), NOT a DB UUID. */
  conversationId?: string;
  /**
   * Run the workflow in a detached background child and return immediately.
   * The parent pins a stable branch + conversation id on the child's argv so
   * exactly one worktree/conversation is created. The child does all the work.
   */
  detach?: boolean;
  /**
   * Emit a machine-readable JSON ack for the spawned child instead of human
   * text. Only meaningful together with `detach`: without `detach` a foreground
   * `workflow run` streams human output and has no JSON ack to emit (passing
   * `--json` alone still suppresses CLI logs but does not change the output).
   */
  json?: boolean;
  /** Simulate deterministic DAG control flow without creating run state or contacting a provider. */
  dryRun?: boolean;
  /** YAML mapping of node ids to scalar or structured simulated outputs. */
  stubsPath?: string;
  /** Write a complete YAML stub scaffold for the discovered workflow and exit. */
  stubsInitPath?: string;
  /** Fill reached nodes missing from the supplied stub map with validated placeholders. */
  defaultStubs?: boolean;
  /** Execute reachable bash/script nodes locally instead of requiring stubs. */
  execCode?: boolean;
  /** Stop at the first approval gate instead of auto-approving it. */
  pauseAtGates?: boolean;
  /**
   * Raw `--input name=value` assignments (#2554), one per occurrence of the flag.
   * Parsed and validated against the workflow's declared `inputs:` at the invocation
   * gate — before the `--detach` fork and before any worktree, clone, or AI cost.
   * Kept as raw strings here so the grammar has exactly one parser
   * (`parseInputAssignments` in `@archon/workflows`).
   */
  inputs?: string[];
  /** Raw repeatable `--model name=spec` mappings; parsed once at the invocation gate. */
  modelAssignments?: string[];
  /** Local YAML file supplying a sparse configuration layer for this run. */
  configPath?: string;
  /** @internal Structurally validated immutable layer transferred from a detached parent. */
  detachedRunConfig?: WorkflowRunConfigInput;
  /**
   * @internal The run row the detached parent created before forking (#2872). Present
   * only on a FRESH detached launch: the child executes this row instead of creating
   * its own, which is what lets the parent's ack hand back a run id whose row already
   * exists. A continuation carries its own run and never sets it.
   */
  detachedRunId?: string;
  /**
   * Between-run continuation (#2747): adopt a terminal run's estate — its
   * worktree/branch plus read access to its artifacts via `$ADOPTED_RUN_DIR`.
   * Run-id only, never a name (#2645): newest-wins selection is the ambiguity
   * class this flag must not introduce.
   */
  adoptRunId?: string;
  /**
   * Between-run continuation (#2747): record that this fresh-lane run replaces
   * the prior run's open item, closing its inbox row through the same
   * no-adopter query. Provenance only — NO lane inheritance.
   */
  supersedesRunId?: string;
}

/**
 * Default runner image when `.archon/config.yaml > container.image` is unset.
 * The build script (`bun run build:runner-image`) tags both
 * `archon-runner:<version>` and `archon-runner:latest`; defaulting to `latest`
 * always matches the most recently built image without coupling to the
 * dev-vs-binary version string. Operators pin `container.image` for reproducibility.
 */
const DEFAULT_RUNNER_IMAGE = 'archon-runner:latest';

/**
 * Resolve the container backend config from the merged `container` config,
 * applying Phase B defaults (bridge network, 4 GiB memory, 512 pids).
 *
 * `container.*` comes from hand-parsed YAML (not Zod), so the values are
 * untrusted at runtime despite their static types — validate them here. In
 * particular `network` must be `bridge`/`none`: a stray `host` would otherwise
 * flow straight to `docker run --network host` and drop the network isolation.
 */
export function resolveContainerBackendConfig(
  cfg: { image?: string; network?: string; memoryMb?: number; pidsLimit?: number } | undefined
): ContainerBackendConfig {
  const network = cfg?.network;
  if (network !== undefined && network !== 'bridge' && network !== 'none') {
    throw new Error(
      `Invalid container.network '${network}' in .archon/config.yaml — must be ` +
        "'bridge' or 'none'. Host networking is not allowed for container isolation."
    );
  }
  // Positive INTEGERS — `docker run --memory`/`--pids-limit` reject fractions,
  // and Number.isFinite alone would let `512.5` through to a runtime docker error.
  const memoryMb = cfg?.memoryMb;
  if (memoryMb !== undefined && (!Number.isInteger(memoryMb) || memoryMb <= 0)) {
    throw new Error(
      `Invalid container.memoryMb '${String(memoryMb)}' — must be a positive integer (MiB).`
    );
  }
  const pidsLimit = cfg?.pidsLimit;
  if (pidsLimit !== undefined && (!Number.isInteger(pidsLimit) || pidsLimit <= 0)) {
    throw new Error(
      `Invalid container.pidsLimit '${String(pidsLimit)}' — must be a positive integer.`
    );
  }
  return {
    image: cfg?.image?.trim() || DEFAULT_RUNNER_IMAGE,
    network: network ?? 'bridge',
    memoryMb: memoryMb ?? 4096,
    pidsLimit: pidsLimit ?? 512,
  };
}

/**
 * H2 — a container run has an UNRESOLVED write-back when its overlay diff was raised
 * for review (`pending_writeback` set) but never applied or discarded
 * (`writeback_resolved !== true`). This happens on a failed/partial apply. The CLI
 * teardown must PRESERVE the container+volume in this state (the overlay is the only
 * copy of the changes) rather than destroy it. Pure so the decision is unit-testable.
 */
export function hasUnresolvedWriteback(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  return metadata.pending_writeback !== undefined && metadata.writeback_resolved !== true;
}

/**
 * Generate a unique conversation ID for CLI usage
 */
function generateConversationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `cli-${String(timestamp)}-${random}`;
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
  const userArgs = argv.slice(2).filter(arg => arg !== '--detach' && arg !== '--json');
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

async function spawnDetachedWorkflowRun(
  cwd: string,
  conversationId: string,
  extraArgs: string[],
  runConfigPayload?: string
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
    // standard fix, also used by setup.ts's trySpawn(); if a kill-on-close Job
    // Object wrapper ever defeats it, a `start /b` breakaway fallback is the
    // next step. `windowsHide` keeps the child headless.
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: {
        ...process.env,
        [DETACHED_RUN_OWNER_ENV]: '1',
        ...(runConfigPayload
          ? {
              // Empty strings preserve meaningful absence: Bun will not fill
              // these from the target repo's auto-loaded .env.
              ...resolveDetachedRunEncryptionEnv(),
            }
          : {}),
      },
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
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
    // setup.ts's trySpawn) — fail fast instead of acking a run that never started.
    if (child.pid === undefined) {
      throw new Error(`Failed to start detached workflow child (executable: ${cmd[0]})`);
    }
    await waitForDetachedStartup(child, logPath, cmd[0], conversationId);
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
 * Parses the "Source symlink at X already points to Y, expected Z" error
 * thrown by `createProjectSourceSymlink` in @archon/paths. Cross-package
 * string contract — if that throw site changes wording, this parser silently
 * stops matching. Returns the workspace dir (parent of the `source` link) so
 * the caller can emit an exact cleanup path, or null if unrecognized.
 */
export function extractStaleWorkspaceEntry(message: string): string | null {
  const prefix = 'Source symlink at ';
  const delimiter = ' already points to ';
  if (!message.startsWith(prefix)) return null;

  const remainder = message.slice(prefix.length);
  const delimiterIndex = remainder.indexOf(delimiter);
  if (delimiterIndex === -1) return null;

  const sourcePath = remainder.slice(0, delimiterIndex).trim();
  const lastSeparator = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  return lastSeparator === -1 ? null : sourcePath.slice(0, lastSeparator);
}

/**
 * Wraps a codebase auto-registration failure for either the worktree-create or
 * resume path. Preserves the original error message and delegates hint detail
 * to `extractStaleWorkspaceEntry`; falls back to a workspace-root pointer when
 * the error shape is unrecognized.
 */
function buildRegistrationFailureError(action: string, error: Error): Error {
  const staleWorkspaceEntry = extractStaleWorkspaceEntry(error.message);
  let hint: string;
  if (staleWorkspaceEntry) {
    hint = `Hint: Remove the stale workspace entry at ${staleWorkspaceEntry} and retry, or use --no-worktree to skip isolation.`;
  } else {
    // Guard against a throwing getArchonHome() (misconfigured env vars, etc.):
    // the registration error we're wrapping is the load-bearing one — we'd
    // rather lose the exact path in the hint than replace it with a secondary
    // home-resolution error that masks the root cause.
    try {
      const workspacesPath = join(getArchonHome(), 'workspaces');
      hint = `Hint: Check your Archon workspace registration under ${workspacesPath} and retry, or use --no-worktree to skip isolation.`;
    } catch {
      hint =
        'Hint: Check your Archon workspace registration and retry, or use --no-worktree to skip isolation.';
    }
  }

  return new Error(
    `Cannot ${action}: repository registration failed.\nError: ${error.message}\n${hint}`
  );
}

/** Error for --branch/--from/--base used against a folder project (no worktree). */
function folderWorktreeOptionError(): Error {
  return new Error(
    'Worktree options require a git-repo project.\n' +
      '  --branch/--from/--base act on an isolated git worktree, which folder projects do not use.\n' +
      '  Drop --branch/--from/--base — folder projects always run in place.'
  );
}

/**
 * Warn that `--base` is only HALF applied when an existing worktree is adopted
 * (`--branch` reuse or `--resume`): its cut-from is already fixed, but the
 * override still reaches `$BASE_BRANCH` and retargets the PR.
 *
 * Deliberately not `--from`'s "was not applied" wording — that is accurate for
 * `--from`, which is wholly inert on reuse, and would understate this case.
 */
function warnBaseOverrideOnReuse(workingPath: string, flagBase: string): void {
  getLog().warn(
    { path: workingPath, baseBranch: flagBase },
    'worktree.reuse_base_override_partial'
  );
  console.warn(
    `Warning: Reusing existing worktree at ${workingPath}. ` +
      `--base ${flagBase} did not change the cut-from (worktree already exists); ` +
      'it still applies to the PR target.'
  );
}

/** Error for a worktree-pinned workflow run against a folder project. */
function folderWorktreePolicyError(workflowName: string): Error {
  return new Error(
    `Workflow '${workflowName}' requires a worktree (worktree.enabled: true), ` +
      'which is not available for folder projects (no git repo to isolate).\n' +
      '  Run this workflow against a git-repo project, or change its worktree policy.'
  );
}

/**
 * Error for a failed `--folder` project registration. Distinct from
 * {@link buildRegistrationFailureError} (which mentions worktrees / `--no-worktree`)
 * because no worktree is ever created for a folder project — that hint would be
 * misleading here.
 */
function buildFolderRegistrationFailureError(error: Error): Error {
  return new Error(
    'Cannot register folder project.\n' +
      `Error: ${error.message}\n` +
      'Hint: Check that the directory is readable and your Archon home ' +
      '(~/.archon) is writable, then retry.'
  );
}

/**
 * Refuse an isolated run that has no project to isolate, naming which step failed.
 *
 * One owner because two callers enforce the same policy at different times: the
 * `--detach` pre-flight, which must refuse before the fork (#2872), and the isolation
 * block, which is where a foreground run reaches it. Two copies of this decision is
 * exactly how the detached path came to skip it.
 *
 * A no-op once a codebase resolved — the isolation block only reaches it with none, and
 * the pre-flight calls it unconditionally for an isolating run.
 */
function assertCodebaseResolvedForIsolation(resolved: {
  codebase: Awaited<ReturnType<typeof codebaseDb.getCodebase>>;
  lookupError: Error | null;
  registrationError: Error | null;
}): void {
  if (resolved.codebase) return;
  if (resolved.lookupError) {
    throw new Error(
      'Cannot create worktree: database lookup failed.\n' +
        `Error: ${resolved.lookupError.message}\n` +
        'Hint: Check your database connection, or use --no-worktree to skip isolation.'
    );
  }
  if (resolved.registrationError) {
    throw buildRegistrationFailureError('create worktree', resolved.registrationError);
  }
  throw new Error(
    'Cannot create worktree: not in a git repository.\n' +
      'Run from within a git repo, or use --no-worktree to skip isolation.'
  );
}

/** The refusal when `--resume` finds nothing to continue. */
function buildNoResumableRunError(workflowName: string, cwd: string): Error {
  return new Error(`No resumable run found for workflow '${workflowName}' at path '${cwd}'.`);
}

/** The refusal when the resumable-run lookup itself could not answer. */
function buildResumeLookupFailureError(error: Error): Error {
  return new Error(
    'Cannot resume: Database lookup failed.\n' +
      `Error: ${error.message}\n` +
      'Hint: Check your database connection before using --resume.'
  );
}

/**
 * Validate a `--supersedes` declaration (#2747): the run must exist and be terminal.
 * Supersede inherits nothing, so existence and terminality are the whole contract.
 *
 * One owner for the refusals because two callers need them: the `--detach` pre-flight,
 * which refuses before forking (#2872), and the run path that records the provenance.
 */
async function resolveSupersededRun(runId: string): Promise<WorkflowRun> {
  const superseded = await workflowDb.getWorkflowRun(runId);
  if (!superseded) {
    throw new Error(`Cannot supersede: no workflow run '${runId}' exists.`);
  }
  if (!TERMINAL_WORKFLOW_STATUSES.includes(superseded.status)) {
    throw new Error(`Cannot supersede run '${superseded.id}': it is still ${superseded.status}.`);
  }
  return superseded;
}

/**
 * The acting CLI user's Archon id, or undefined when `ARCHON_USER_ID`/`$USER` is unset
 * or the identity cannot be resolved. Attribution is best-effort by design — a run must
 * not fail because the user table could not be reached.
 */
async function resolveCliUserRecordId(): Promise<string | undefined> {
  const cliId = resolveCliUserId();
  if (!cliId) return undefined;
  try {
    const cliUser = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    return cliUser.id;
  } catch (error) {
    getLog().warn({ err: error as Error, cliId }, 'cli.user_identity_resolve_failed');
    return undefined;
  }
}

/**
 * Fail fast if `--branch`/`--from`/`--base` (git-worktree-only options) are used
 * against a folder project. Called at three sites — flag-declared (pre-detach), the
 * detach fast-path, and post-lookup (authoritative) — so the check lives in one place.
 *
 * `--base` belongs here even though a folder run creates no worktree for it to
 * redirect: it would still reach `$BASE_BRANCH`, giving the run a PR target with
 * no worktree behind it.
 */
function assertNoWorktreeOptionsForFolder(
  isFolderProject: boolean,
  options: WorkflowRunOptions
): void {
  if (
    isFolderProject &&
    (options.branchName !== undefined ||
      options.fromBranch !== undefined ||
      options.baseBranch !== undefined)
  ) {
    throw folderWorktreeOptionError();
  }
}

/** Fail fast if a `worktree.enabled: true` workflow is run against a folder project. */
function assertWorkflowNotWorktreePinnedForFolder(
  isFolderProject: boolean,
  pinnedEnabled: boolean | undefined,
  workflowName: string
): void {
  if (isFolderProject && pinnedEnabled === true) {
    throw folderWorktreePolicyError(workflowName);
  }
}

/**
 * Capability gate for the CLI run path.
 *
 * Mirrors the orchestrator's `requires: [github]` enforcement
 * (orchestrator-agent.ts `dispatchOrchestratorWorkflow`) so a workflow that
 * declares `requires: [github]` is hard-blocked BEFORE any worktree/clone/AI
 * cost — and before the `--detach` fork — when the acting CLI user hasn't
 * connected their GitHub identity. Throws WorkflowRequirementError, surfaced by
 * the CLI top-level handler (cli.ts) as a clean, actionable `Error: ...` line.
 *
 * No-op on solo PAT installs: `isPerUserGitHubEnabled()` is false unless the
 * GitHub App + TOKEN_ENCRYPTION_KEY are both configured — identical semantics
 * to the orchestrator gate.
 */
async function assertCliWorkflowRequirementsMet(workflow: WorkflowDefinition): Promise<void> {
  if (!isPerUserGitHubEnabled() || !workflow.requires?.length) return;

  // Resolve the acting CLI user (ARCHON_USER_ID, else $USER/$USERNAME) → Archon
  // user id, then check for a stored GitHub connection. An unresolvable user or
  // a lookup failure means "not connected" — fail closed, never silently allow.
  const cliId = resolveCliUserId();
  let githubConnected = false;
  if (cliId) {
    try {
      const cliUser = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
      githubConnected = Boolean(await getDecryptedAccessToken(cliUser.id));
    } catch (error) {
      getLog().warn({ err: error as Error, cliId }, 'cli.requirement_gate_user_resolve_failed');
    }
  }

  assertWorkflowRequirementsMet(workflow, { githubConnected });
}

async function resolveCliDryRunAiPrefs(): Promise<Awaited<ReturnType<typeof getUserAiPrefs>>> {
  const cliId = resolveCliUserId();
  if (!cliId) return {};
  try {
    const cliUser = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
    return await getUserAiPrefs(cliUser.id);
  } catch (error) {
    getLog().warn({ err: error as Error, cliId }, 'cli.dry_run_user_ai_prefs_resolve_failed');
    return {};
  }
}

/**
 * Resolve the provider used for CLI conversation titles from the workflow itself.
 * This keeps auxiliary title generation aligned with workflow execution instead
 * of falling back to a stale conversation default.
 */
function resolveTitleAssistantType(
  declared: DeclaredWorkflowConfig | undefined,
  defaultAssistant: string | undefined,
  conversationAssistant: string | undefined
): string {
  // Reads what the AUTHOR declared, not the expanded definition: expansion collapses
  // workflow-level config onto the nodes and removes it (#1764), so the expanded object
  // has no `provider` and every Codex workflow would be labelled with the fallback.
  //
  // The top-level file's own `provider:` is the right answer even though a composition
  // can span providers — no single label is fully true then, and the file the user
  // invoked is the honest one. Model never influences provider selection: vendor SDKs
  // add model names faster than a mapping could track.
  const fallbackAssistant = defaultAssistant ?? conversationAssistant ?? 'claude';
  return declared?.provider ?? fallbackAssistant;
}

/**
 * Print a one-time per-version tier notice to stderr when the workflow uses
 * unconfigured tier-keyword nodes (small/medium/large resolving via built-in
 * defaults). Suppressed under --quiet. Uses the same 7-char tier column as
 * `archon ai tier list`.
 */
export async function maybePrintTierNotice(
  workflow: WorkflowDefinition,
  cwd: string,
  cliUserId: string | undefined,
  quiet: boolean | undefined
): Promise<void> {
  if (quiet) return;

  // Collect tier keywords used by the workflow — check the workflow-level default
  // first (model: large at the top level applies to all nodes without overrides),
  // then per-node overrides.
  const usedTiers = new Set<TierName>();
  if (typeof workflow.model === 'string' && isTierName(workflow.model)) {
    usedTiers.add(workflow.model);
  }
  for (const node of workflow.nodes) {
    if ('model' in node && typeof node.model === 'string' && isTierName(node.model)) {
      usedTiers.add(node.model);
    }
  }
  if (usedTiers.size === 0) return;

  // Load install config to see which tiers are explicitly configured.
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(cwd);
  } catch (err) {
    getLog().debug({ err }, 'tier_notice.config_load_failed');
    return;
  }
  const configuredTiers: RawTiersConfig = config.tiers ?? {};

  // Layer in the CLI user's personal tier prefs (best-effort, non-fatal).
  let userTiers: RawTiersConfig = {};
  let userDefaultProvider: string | undefined;
  if (cliUserId) {
    try {
      const prefs = await getUserAiPrefs(cliUserId);
      userTiers = prefs.tiers ?? {};
      userDefaultProvider = prefs.defaultProvider;
    } catch {
      // Non-fatal — proceed without user tier info.
    }
  }

  // Only notify when at least one used tier is unconfigured (built-in default).
  const hasUnconfigured = [...usedTiers].some(t => !configuredTiers[t] && !userTiers[t]);
  if (!hasUnconfigured) return;

  // One-time per Archon version (a version bump may ship new tier defaults).
  const version = BUNDLED_VERSION;
  if (readTierNoticeState()?.shownForVersion === version) return;

  // Build the resolved profile for the effective default assistant.
  const effectiveAssistant = userDefaultProvider ?? config.assistant;
  let aliases: ReturnType<typeof buildAiProfile>['aliases'];
  try {
    aliases = buildAiProfile(effectiveAssistant, {
      globalTiers: configuredTiers,
      userTiers,
    }).aliases;
  } catch (err) {
    // Non-fatal: a corrupt tier/alias config can make buildAiProfile throw —
    // skip the notice rather than blocking the run.
    getLog().debug({ err }, 'tier_notice.build_profile_failed');
    return;
  }

  const tierLines: string[] = [];
  for (const t of TIER_NAMES) {
    const preset = aliases[t];
    if (preset) tierLines.push(`     ${t.padEnd(7)} → ${preset.provider}/${preset.model}`);
  }
  // Only claude and codex ship built-in tier defaults. With none for this
  // provider there is nothing truthful to announce — the run's tier
  // resolution fails loudly with the full configuration guidance, and this
  // notice must not claim defaults are in play. Not marked shown: once the
  // operator configures tiers for a provider WITH built-ins, the one-time
  // notice should still fire.
  if (tierLines.length === 0) return;
  const lines: string[] = [
    "ℹ️  This workflow uses model tiers (small/medium/large). You haven't configured them —",
    `   using built-in defaults for '${effectiveAssistant}':`,
    ...tierLines,
  ];
  // Plan-dependent 1M note for the large→opus row (the CLI can't detect the plan).
  const largePreset = aliases.large;
  if (largePreset?.provider === 'claude' && largePreset.model === 'opus') {
    lines.push(
      '   (Opus runs a 1M context window on API keys and Max/Team/Enterprise;',
      "    on Pro it's 200K unless you set the `large` tier to `opus[1m]`.)"
    );
  }
  lines.push(
    '   Customize: `archon ai tier set <tier> <provider> <model>`',
    '              or `tiers:` in .archon/config.yaml',
    '   See anytime: `archon ai tier list`           (shown once per version)',
    ''
  );
  process.stderr.write(lines.join('\n') + '\n');

  markTierNoticeShown(version);
}

/** Render a workflow event to stderr as a progress line. Called only when --quiet is not set. */
function renderWorkflowEvent(event: WorkflowEmitterEvent, verbose: boolean): void {
  switch (event.type) {
    case 'node_started': {
      let suffix = '';
      if (event.provider !== undefined && event.model !== undefined) {
        const tierPart = event.tier !== undefined ? ` ← ${event.tier}` : '';
        suffix = `  (${event.provider}/${event.model}${tierPart})`;
      }
      process.stderr.write(`[${event.nodeName}] Started${suffix}\n`);
      break;
    }
    case 'node_completed':
      process.stderr.write(`[${event.nodeName}] Completed (${formatDuration(event.duration)})\n`);
      break;
    case 'node_failed':
      process.stderr.write(`[${event.nodeName}] Failed: ${event.error}\n`);
      break;
    case 'node_skipped':
      process.stderr.write(`[${event.nodeName}] Skipped (${event.reason})\n`);
      break;
    case 'approval_pending':
      process.stderr.write(`[${event.nodeId}] Waiting for approval: ${event.message}\n`);
      break;
    case 'container_lifecycle': {
      const idPart = event.containerId ? ` ${event.containerId.slice(0, 12)}` : '';
      process.stderr.write(`[container] ${event.phase}${idPart}\n`);
      break;
    }
    case 'tool_started':
      if (verbose) {
        process.stderr.write(
          `[${event.stepName}] tool: ${event.toolName} (started, ${event.toolCallId})\n`
        );
      }
      break;
    case 'tool_completed':
      if (verbose) {
        const outcome = event.toolOutcome ? `, ${event.toolOutcome}` : '';
        const exitCode = event.exitCode !== undefined ? `, exit ${String(event.exitCode)}` : '';
        process.stderr.write(
          `[${event.stepName}] tool: ${event.toolName} (${String(event.durationMs)}ms, ${event.toolCallId}${outcome}${exitCode})\n`
        );
      }
      break;
    default:
      // Workflow-level, loop, artifact, and cancelled events are intentionally not rendered.
      break;
  }
}

/**
 * Load workflows from the DISCOVERY root with standardized error handling.
 *
 * The root passed here owns both the workflow files and the `defaults:` /
 * `commands.folder` settings that govern how they are discovered — a workflow's own
 * checkout decides which command folder its command nodes name. What the run then DOES
 * is governed separately by the target's config, loaded inside `executeWorkflow`.
 */
async function loadWorkflows(cwd: string): Promise<WorkflowLoadResult> {
  try {
    // Home-scoped workflows at ~/.archon/workflows/ are discovered automatically —
    // no option needed since the discovery helper reads them unconditionally.
    return await discoverWorkflowsWithConfig(cwd, loadConfig);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Error loading workflows: ${err.message}\nHint: Check permissions on .archon/workflows/ directory.`
    );
  }
}

/**
 * Print a workflow's parse warnings (keys the engine silently drops) to stderr.
 *
 * stderr rather than stdout so `--json` callers keep a parseable payload while
 * still being told; `console.warn` rather than the logger because `--json` sets
 * the log level to silent, which is exactly the case this has to survive.
 */
export function emitParseWarnings(
  parseWarnings: readonly string[] | undefined,
  workflowName: string
): void {
  if (!parseWarnings || parseWarnings.length === 0) return;
  console.warn(`Warning: '${workflowName}' declares keys the engine ignores:`);
  for (const warning of parseWarnings) {
    console.warn(`  - ${warning}`);
  }
}

/**
 * Print a deprecated workflow's removal notice (#2781) to stderr.
 *
 * Same channel as emitParseWarnings: stderr keeps `--json` stdout parseable,
 * and `console.warn` survives `--json`'s log silencing. Not gated on --quiet —
 * a user driving runs programmatically still has to learn the default they
 * picked is scheduled for removal.
 */
export function emitDeprecationNotice(workflow: WorkflowDefinition): void {
  const notice = formatDeprecationNotice(workflow);
  if (notice) console.warn(notice);
}

function countWorkflowSources(
  workflows: readonly WorkflowWithSource[]
): Record<WorkflowSource, number> {
  return workflows.reduce<Record<WorkflowSource, number>>(
    (counts, entry) => {
      counts[entry.source] += 1;
      return counts;
    },
    { bundled: 0, global: 0, project: 0 }
  );
}

interface WorkflowJsonEntry {
  name: string;
  description: string;
  provider?: string;
  model?: string;
  /** Reasoning depth — the one spelling, on every provider that has one (#2556).
   *  A workflow written with the deprecated `modelReasoningEffort:` reports its
   *  value here, since the loader translates the two into one field. */
  effort?: string;
  webSearchMode?: string;
  /** Keys the workflow's YAML declares that the engine drops (#2213). */
  parseWarnings?: string[];
}

/**
 * Run every declared dry-run fixture and report per-fixture pass/fail (#2772).
 *
 * Read-only by construction — the only execution path is `dryRunWorkflow`, so no
 * run state is created and no provider is contacted. Returns the process exit code:
 * 0 when everything passes (including the nothing-declared case), 1 when any fixture
 * fails, a workflow cannot load, or an explicitly named target has none.
 */
export async function workflowTestCommand(
  cwd: string,
  target: string | undefined,
  options: { json?: boolean; targetCwd?: string } = {}
): Promise<number> {
  const { workflows, errors } = await loadWorkflows(cwd);
  // The fixture runner freezes this repo's source before executing anything, exactly as
  // `workflow run` does, and this config decides which directories get frozen. A malformed
  // one would silently narrow that set, so it fails here instead; `loadConfig` returns
  // defaults when there is simply no config file.
  const config = await loadConfig(cwd).catch((error: unknown) => {
    throw new Error(
      `Cannot read the workflow source configuration in ${cwd}: ${(error as Error).message}`
    );
  });
  let report: Awaited<ReturnType<typeof runFixtures>>;
  try {
    report = await runFixtures({
      workflows,
      cwd,
      ...(options.targetCwd !== undefined ? { targetCwd: options.targetCwd } : {}),
      sourceConfig: workflowSourceConfigFrom(config),
      ...(target !== undefined ? { target } : {}),
    });
  } catch (error) {
    if (errors.length === 0) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      await writeJsonLine({
        ok: false,
        error: message,
        errors: errors.map(e => ({
          filename: e.filename,
          error: e.error,
          errorType: e.errorType,
        })),
      });
    } else {
      let output = `Error: ${message}\n`;
      if (errors.length > 0) {
        output += `\n${errors.length} workflow(s) failed to load:\n\n`;
        for (const loadError of errors) {
          output += `  ${loadError.filename}: ${loadError.error}\n`;
        }
      }
      await writeStdout(output);
    }
    return 1;
  }

  if (options.json) {
    await writeJsonLine({
      results: report.results.map(r => ({
        ...r,
        missingStubs: [...r.missingStubs],
        toleratedMissingStubs: [...r.toleratedMissingStubs],
        unusedStubs: [...r.unusedStubs],
      })),
      passed: report.passed,
      failed: report.failed,
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    });
  } else {
    let output = `${formatFixtureReport(report)}\n`;
    if (errors.length > 0) {
      output += `\n${errors.length} workflow(s) failed to load:\n\n`;
      for (const error of errors) {
        output += `  ${error.filename}: ${error.error}\n`;
      }
    }
    await writeStdout(output);
  }

  if (
    errors.length > 0 ||
    report.failed > 0 ||
    (target !== undefined && report.results.length === 0)
  ) {
    return 1;
  }
  return 0;
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(cwd: string, json?: boolean): Promise<void> {
  const { workflows: workflowEntries, errors } = await loadWorkflows(cwd);

  if (json) {
    const output = {
      // `declared` rather than the expanded workflow: composition collapses these fields
      // onto the nodes and removes them (#1764), so the listing reports what the author
      // wrote. `webSearchMode` is the one that stays on the definition — it has no
      // per-node form to collapse onto.
      workflows: workflowEntries.map(
        ({ workflow: w, parseWarnings, declared }): WorkflowJsonEntry => {
          const entry: WorkflowJsonEntry = {
            name: w.name,
            description: w.description,
          };
          if (declared?.provider !== undefined) entry.provider = declared.provider;
          if (declared?.model !== undefined) entry.model = declared.model;
          if (declared?.effort !== undefined) entry.effort = declared.effort;
          if (w.webSearchMode !== undefined) entry.webSearchMode = w.webSearchMode;
          if (parseWarnings && parseWarnings.length > 0) entry.parseWarnings = [...parseWarnings];
          return entry;
        }
      ),
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    };
    await writeJsonLine(output);
    return;
  }

  console.log(`Discovering workflows in: ${cwd}`);

  if (workflowEntries.length === 0 && errors.length === 0) {
    console.log('\nNo workflows found.');
    console.log('Workflows should be in .archon/workflows/ directory.');
    return;
  }

  if (workflowEntries.length > 0) {
    console.log(`\nFound ${workflowEntries.length} workflow(s):\n`);

    for (const { workflow, parseWarnings, declared } of workflowEntries) {
      console.log(`  ${workflow.name}`);
      console.log(`    ${workflow.description}`);
      if (declared?.provider) {
        console.log(`    Provider: ${declared.provider}`);
      }
      for (const warning of parseWarnings ?? []) {
        console.log(`    Warning: ${warning}`);
      }
      console.log('');
    }
  }

  if (errors.length > 0) {
    console.log(`\n${errors.length} workflow(s) failed to load:\n`);
    for (const e of errors) {
      console.log(`  ${e.filename}: ${e.error}`);
    }
    console.log('');
  }
}

/**
 * Resolve the project this run belongs to: look it up, else register it.
 *
 * Exact `default_cwd` match first, then a path-prefix lookup so a subdirectory or
 * worktree UNDER a registered root resolves to its covering codebase. Without the
 * prefix fallback, resume/approve re-enter with cwd = the run's worktree
 * working_path, miss the exact match, and fall through to auto-registration —
 * which trips the source-symlink guard for an already-covered path (#2127).
 *
 * One implementation because two callers need the same answer: the `--detach`
 * pre-flight, which must resolve the project before it can create the run row or
 * refuse an adoption (#2872), and the run path itself. Registration is idempotent,
 * so the detached child's own call finds what the parent registered.
 *
 * Returns the failures rather than throwing: the caller decides which of them is
 * fatal, and those decisions differ (a `--folder` registration failure is always
 * fatal; a lookup failure is only fatal for `--resume` and adoption). It reports
 * a first-time folder registration the same way — as a fact, not a `console.log` —
 * because one caller emits a machine-readable document on stdout and cannot have a
 * sentence written into the middle of it.
 */
async function resolveRunCodebase(
  cwd: string,
  options: Pick<WorkflowRunOptions, 'codebaseId' | 'folder'>
): Promise<{
  codebase: Awaited<ReturnType<typeof codebaseDb.getCodebase>>;
  lookupError: Error | null;
  registrationError: Error | null;
  /** Set only when THIS call registered a new folder project. */
  registeredFolder?: { name: string; defaultCwd: string };
}> {
  let codebase: Awaited<ReturnType<typeof codebaseDb.getCodebase>> = null;
  let lookupError: Error | null = null;
  let registrationError: Error | null = null;
  let registeredFolder: { name: string; defaultCwd: string } | undefined;
  try {
    codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
  } catch (error) {
    const err = error as Error;
    lookupError = err;
    getLog().warn({ err, cwd }, 'cli.codebase_lookup_failed');
    if (
      err.message.includes('connect') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ETIMEDOUT')
    ) {
      getLog().warn(
        { hint: 'Check DATABASE_URL and that the database is running.' },
        'cli.db_connection_hint'
      );
    }
  }

  // If the caller supplied a codebase ID (e.g., from a stored run record on resume),
  // use it directly to avoid path-based lookup that fails for worktree paths.
  if (!codebase && !lookupError && options.codebaseId) {
    try {
      codebase = await codebaseDb.getCodebase(options.codebaseId);
    } catch (error) {
      const err = error as Error;
      getLog().warn(
        { err, errorType: err.constructor.name, codebaseId: options.codebaseId },
        'cli.codebase_id_lookup_failed'
      );
      // Intentional: don't set lookupError — fall through to auto-registration
    }
  }

  // Auto-register unregistered repos (creates project structure for artifacts/logs)
  if (!codebase && !lookupError) {
    const repoRoot = await git.findRepoRoot(cwd);
    if (repoRoot) {
      try {
        const result = await registerRepository(repoRoot);
        codebase = await codebaseDb.getCodebase(result.codebaseId);
        if (!result.alreadyExisted) {
          getLog().info({ name: result.name }, 'cli.codebase_auto_registered');
        }
      } catch (error) {
        const err = error as Error;
        registrationError = err;
        getLog().warn(
          { err, errorType: err.constructor.name, repoRoot },
          'cli.codebase_auto_registration_failed'
        );
      }
    } else if (options.folder) {
      // Non-git cwd + explicit --folder: register a folder project (runs in
      // place). Without --folder the cli.ts gate already errored for
      // unregistered non-git cwds, so this branch is only reached via the flag.
      try {
        const result = await registerFolder(cwd);
        codebase = await codebaseDb.getCodebase(result.codebaseId);
        if (!result.alreadyExisted) {
          registeredFolder = { name: result.name, defaultCwd: result.defaultCwd };
          getLog().info({ name: result.name }, 'cli.folder_project_auto_registered');
        }
      } catch (error) {
        const err = error as Error;
        registrationError = err;
        getLog().warn(
          { err, errorType: err.constructor.name, cwd },
          'cli.folder_project_auto_registration_failed'
        );
      }
    }
  }

  return { codebase, lookupError, registrationError, registeredFolder };
}

/**
 * Run a specific workflow
 */
async function runWorkflowWithOwnedSource(
  owner: CapturedSourceOwner,
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {}
): Promise<void> {
  const detachedProcessOwner = process.env[DETACHED_RUN_OWNER_ENV] === '1';
  if (detachedProcessOwner) Reflect.deleteProperty(process.env, DETACHED_RUN_OWNER_ENV);
  if (detachedProcessOwner) assertDetachedRunProcessOwner();
  const effectiveDiscoveryCwd = options.discoveryCwd ?? cwd;
  const modelOverrides = options.modelAssignments
    ? parseRunModelAssignments(options.modelAssignments)
    : undefined;

  // Freeze the source BEFORE discovering, then discover from the frozen copy. Discovering
  // first and capturing after would leave a window where the YAML this run executes and
  // the commands and scripts it calls come from two different moments — the drift the
  // capture exists to remove, reintroduced at the one place nobody would look for it.
  //
  // A dry run creates no run and no artifacts, so it has nothing to freeze into and reads
  // live, exactly as it did before captures existed.
  // Continuing an existing run: discover from the source it recorded, and take no new
  // capture. The MANIFEST supplies the settings those roots resolve under — building them
  // from defaults instead re-discovered a different DAG on any repo with a non-default
  // `commands.folder`, confidently rather than degraded, because a defined-but-default
  // config also suppresses discovery's live-config fallback.
  // Continuation goes through the shared entry point, like chat and web. The CLI used to
  // hand-roll the same load/rebuild/discover sequence: correct at the time, which is the
  // risk — a change to the shared path would silently not reach CLI resume, and that is
  // exactly the shape that produced the mixed-vintage and default-settings bugs.
  //
  // `run <name> --resume` is a continuation too, but it arrives as a flag rather than as a
  // run: its row is only located much further down, where it binds the worktree. That is
  // too late to choose the graph. Resolving it here is what makes every resume form — this
  // flag, `resume <id>`, approve, reject, parent auto-resume — reach the shared entry point
  // with a run in hand, and it also stops the id-based forms re-finding by name a run they
  // already identified exactly (#2645).
  let resumeLookupError: Error | undefined;
  let continuationRun = options.continuationRun;
  if (continuationRun === undefined && options.resume === true) {
    try {
      continuationRun = (await workflowDb.findResumableRun(workflowName, cwd)) ?? undefined;
    } catch (error) {
      // The resume block below owns the actionable message for a database that cannot
      // answer, and reports the codebase failure first. Nothing executes before it.
      resumeLookupError = error as Error;
    }
  }

  let continuation: ResolvedContinuation | undefined;
  if (continuationRun !== undefined) {
    continuation = await resolveContinuationWorkflow(createWorkflowDeps(), continuationRun, cwd);
  }

  // A continuation never captures. With a record it reads that record (above); without
  // one it is a run created before captures existed, and reads live source — the same
  // legacy path the executor takes for it. Capturing here would freeze bytes the run
  // never agreed to and still not make it deterministic.
  const isContinuation = options.resume === true || continuationRun !== undefined;

  const resolvedRunConfigPath = options.configPath
    ? isAbsolute(options.configPath)
      ? options.configPath
      : join(cwd, options.configPath)
    : undefined;
  if (isContinuation && (resolvedRunConfigPath || options.detachedRunConfig)) {
    throw new Error(RESUME_RUN_CONFIG_CONFLICT);
  }
  const runConfig = options.detachedRunConfig
    ? {
        ...options.detachedRunConfig,
        layer: normalizeRunConfigSemantics(options.detachedRunConfig.layer),
      }
    : resolvedRunConfigPath
      ? await loadWorkflowRunConfigFile(resolvedRunConfigPath)
      : undefined;

  // The row a detached parent created before forking (#2872). Loaded up front because
  // it decides the run's identity: the capture is filed under its id, the signal
  // handlers own it, and `executeWorkflow` executes it instead of creating a second
  // row.
  //
  // The flag names a run row this process will execute AS, so three things are checked.
  // Be precise about which one carries the weight, because it is not the first.
  //
  // The owner marker plus `assertDetachedRunProcessOwner` (above) raise the bar, they do
  // not prove provenance: a plain scripted process is not its own process-group leader,
  // so cron, CI, and wrapper scripts are blocked — but a foreground command under a real
  // pseudo-tty IS one by default, so a person setting the env var at their own terminal
  // satisfies it. Treat it as a barrier to automated misuse, not as proof that an Archon
  // parent launched this process.
  //
  // The catastrophic outcomes are closed by the other two, which hold no matter how the
  // first is satisfied. `status === 'pending'` is what stops a stale or mistyped id from
  // loading a TERMINAL row, whose DAG the executor would re-run, appending events onto
  // closed evidence. The `workflow_name` match (checked once the workflow resolves,
  // below) is what stops one launch's row being executed as another workflow. Neither is
  // redundant with the process-group check, and removing either reopens its own outcome.
  let detachedPreCreatedRun: WorkflowRun | undefined;
  if (options.detachedRunId !== undefined) {
    if (!detachedProcessOwner) {
      throw new Error(
        '--internal-detached-run-id is set by a detached launch for its own child. ' +
          'Use `archon workflow run <name> --detach`.'
      );
    }
    detachedPreCreatedRun = (await workflowDb.getWorkflowRun(options.detachedRunId)) ?? undefined;
    if (!detachedPreCreatedRun) {
      throw new Error(
        `Detached workflow child cannot find the run '${options.detachedRunId}' its launcher created.`
      );
    }
    if (detachedPreCreatedRun.status !== 'pending') {
      throw new Error(
        `Cannot execute run '${detachedPreCreatedRun.id}': it is ${detachedPreCreatedRun.status}, ` +
          'not a run awaiting its first execution. Resume it with `archon workflow resume` instead.'
      );
    }
  }

  let preparedSource: PreparedWorkflowSource | undefined;
  // Pinned at the moment of prepare so the SIGINT/SIGTERM cleanup never rm's a
  // path a live run is reading from. For `--container` folder-codebase runs,
  // `finalizeWorkflowSource` (workflow.ts:1749) reassigns `preparedSource` to a
  // new object whose `captureRoot` is the LIVE artifacts directory the run
  // executes from — rm-ing `preparedSource.captureRoot` on Ctrl-C mid-run would
  // destroy the run's source. The original staged path is renamed away by
  // either `finalizeWorkflowSource` (container) or `executeWorkflow`'s rename
  // (everything else), so an `rm` against it is a no-op once prep has moved it.
  let originalStagedRoot: string | undefined;
  if (!isContinuation && !options.dryRun && !options.stubsInitPath) {
    try {
      preparedSource = await prepareWorkflowSource(createWorkflowDeps(), {
        sourceRoot: effectiveDiscoveryCwd,
        // Keep the capture filed under the run it belongs to when the row already exists.
        ...(detachedPreCreatedRun ? { runId: detachedPreCreatedRun.id } : {}),
      });
      // From here the owner reclaims it unless a run adopts it, whichever way we leave.
      owner.hold(preparedSource);
      originalStagedRoot = preparedSource.captureRoot;
    } catch (error) {
      throw new Error(
        `Failed to capture workflow source from ${effectiveDiscoveryCwd}: ${(error as Error).message}`
      );
    }
  }

  // A resolved continuation already discovered over its own roots; reusing that result is
  // what keeps a resume from paying digest verification and full discovery twice.
  // Mutable: an adopt lane that runs inside the adopted run's worktree re-freezes and
  // re-discovers from THAT checkout once its path is known (see recaptureForLane).
  let { workflows: workflowEntries, errors } = continuation
    ? { workflows: continuation.workflows, errors: continuation.errors }
    : preparedSource
      ? await discoverWorkflowsWithConfig(cwd, loadConfig, preparedSource.roots)
      : await loadWorkflows(effectiveDiscoveryCwd);
  const sourceCounts = countWorkflowSources(workflowEntries);

  if (!options.json && !options.quiet) {
    console.log(
      `Discovery: root=${effectiveDiscoveryCwd} workflows=${String(workflowEntries.length)} ` +
        `bundled=${String(sourceCounts.bundled)} global=${String(sourceCounts.global)} ` +
        `project=${String(sourceCounts.project)}`
    );
  }

  if (workflowEntries.length === 0 && errors.length === 0) {
    // No manual cleanup here or anywhere else in this function: the owner reclaims
    // anything unadopted on the way out, which is the point of having one.
    throw new Error('No workflows found in .archon/workflows/');
  }

  const workflows = workflowEntries.map(ws => ws.workflow);

  // A continuation executes the graph it froze; only a fresh invocation resolves by name.
  let workflow = continuation?.workflow ?? resolveWorkflowName(workflowName, workflows);
  // Recover the discovery entry (dropped by the .map above) for telemetry —
  // bundled workflows report their real name, custom ones report "custom" —
  // and for the parse warnings surfaced just below.
  let workflowEntry = workflow ? workflowEntries.find(ws => ws.workflow === workflow) : undefined;
  let workflowSource = workflowEntry?.source;

  // An adoption lane that executes inside an inherited or freshly cut worktree must run
  // THAT checkout's `.archon`, not the parent checkout's bytes captured on entry — the
  // branch may carry a different workflow YAML, and executing one against the other is
  // exactly the mixed-vintage defect (#2660/#2747). Re-freeze the source and re-discover
  // from the lane path once the lane resolves it.
  const recaptureForLane = async (sourceRoot: string): Promise<void> => {
    try {
      const replacement = await prepareWorkflowSource(createWorkflowDeps(), {
        sourceRoot,
        ...(detachedPreCreatedRun ? { runId: detachedPreCreatedRun.id } : {}),
      });
      owner.hold(replacement);
      originalStagedRoot = replacement.captureRoot;
      const stale = preparedSource;
      preparedSource = replacement;
      if (stale) {
        rmSync(stale.captureRoot, { recursive: true, force: true });
      }
    } catch (error) {
      throw new Error(
        `Failed to capture workflow source from ${sourceRoot}: ${(error as Error).message}`
      );
    }
    const rediscovered = await discoverWorkflowsWithConfig(
      sourceRoot,
      loadConfig,
      preparedSource.roots
    );
    workflowEntries = rediscovered.workflows;
    errors = rediscovered.errors;
    workflow = resolveWorkflowName(
      workflowName,
      workflowEntries.map(ws => ws.workflow)
    );
    workflowEntry = workflow ? workflowEntries.find(ws => ws.workflow === workflow) : undefined;
    workflowSource = workflowEntry?.source;
    if (!workflow) {
      const availableWorkflows = workflowEntries.map(ws => `  - ${ws.workflow.name}`).join('\n');
      throw new Error(
        `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
      );
    }
    await recordSelectedWorkflow(preparedSource.captureRoot, workflow.name);
    emitParseWarnings(workflowEntry?.parseWarnings, workflow.name);
    emitDeprecationNotice(workflow);
    // The gates above ran against the parent checkout's YAML; this lane executes the
    // branch's graph, so judge the same signature gates against the branch vintage
    // (mirrors the orchestrator's deferred runSignatureGates).
    if (!options.resume) {
      resolvedInputs = resolveTopLevelInputs(
        workflow,
        options.inputs ? parseInputAssignments(options.inputs) : undefined
      );
    }
    await assertCliWorkflowRequirementsMet(workflow);
  };

  // Name the selection in the capture's manifest, now that it is known. The manifest is
  // outside the digest, so this records provenance without disturbing what was frozen.
  if (workflow && preparedSource) {
    await recordSelectedWorkflow(preparedSource.captureRoot, workflow.name);
  }

  if (!workflow) {
    // Check if the requested workflow had a load error
    const loadError = errors.find(
      e =>
        e.filename.replace(/\.ya?ml$/, '') === workflowName ||
        e.filename === `${workflowName}.yaml` ||
        e.filename === `${workflowName}.yml`
    );
    if (loadError) {
      throw new Error(
        `Workflow '${workflowName}' failed to load: ${loadError.error}\n\nFix the YAML file and try again.`
      );
    }
    const availableWorkflows = workflows.map(w => `  - ${w.name}`).join('\n');
    throw new Error(
      `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
    );
  }

  // Second half of the handed-over row's claim check (#2872): the row must belong to the
  // workflow being invoked. Checked here rather than at load because the row carries the
  // RESOLVED name its launcher selected, and resolution needs discovery. It catches an
  // id crossed between two concurrent detached launches, and the narrow window where the
  // child's re-capture resolves a different workflow than the parent did.
  if (detachedPreCreatedRun && detachedPreCreatedRun.workflow_name !== workflow.name) {
    throw new Error(
      `Cannot execute run '${detachedPreCreatedRun.id}': it belongs to workflow ` +
        `'${detachedPreCreatedRun.workflow_name}', not '${workflow.name}'.`
    );
  }

  // Keys this workflow's YAML declares that the engine drops (#2213). Written to
  // stderr, never stdout: in --json mode Pino is silenced and stdout must stay
  // exactly the machine-readable payload, so this is the ONLY channel that
  // reaches an agent driving runs through `--json`. Not gated on --quiet — a
  // dropped key can be a gate the author believes is protecting the run.
  emitParseWarnings(workflowEntry?.parseWarnings, workflow.name);
  emitDeprecationNotice(workflow);

  if (isContinuation && options.modelAssignments && options.modelAssignments.length > 0) {
    throw new Error(
      '--resume and --model are mutually exclusive. A resumed run keeps its original model bindings.'
    );
  }

  const dryRunOnlyOptions = [
    ['--stubs', options.stubsPath !== undefined],
    ['--stubs-init', options.stubsInitPath !== undefined],
    ['--default-stubs', options.defaultStubs === true],
    ['--exec-code', options.execCode === true],
    ['--pause-at-gates', options.pauseAtGates === true],
  ] as const;
  const optionWithoutDryRun = dryRunOnlyOptions.find(([, present]) => present)?.[0];
  if (!options.dryRun && optionWithoutDryRun) {
    throw new Error(`${optionWithoutDryRun} requires --dry-run.`);
  }

  if (options.dryRun) {
    const incompatible = [
      ['--branch', options.branchName !== undefined],
      ['--from/--from-branch', options.fromBranch !== undefined],
      ['--base', options.baseBranch !== undefined],
      ['--no-worktree', options.noWorktree === true],
      ['--folder', options.folder === true],
      ['--container', options.container === true],
      ['--resume', options.resume === true],
      ['--detach', options.detach === true],
    ] as const;
    const incompatibleFlag = incompatible.find(([, present]) => present)?.[0];
    if (incompatibleFlag) {
      throw new Error(`--dry-run cannot be combined with ${incompatibleFlag}.`);
    }
    if (options.stubsInitPath !== undefined && options.stubsPath !== undefined) {
      throw new Error('--stubs-init cannot be combined with --stubs.');
    }
    if (options.stubsInitPath !== undefined && options.defaultStubs) {
      throw new Error('--stubs-init cannot be combined with --default-stubs.');
    }

    // The IDENTICAL invocation gate a real run passes through below (#2610): parse
    // `--input name=value`, validate against the declared `inputs:` contract, and fail
    // with the same errors (undeclared key, missing required) before any trace output.
    // Only the supplied entries travel; the simulator derives declared defaults itself,
    // mirroring the executor's `defaultRunInputs` merge at run start.
    const dryRunInputs = resolveTopLevelInputs(
      workflow,
      options.inputs ? parseInputAssignments(options.inputs) : undefined
    );

    // Relative stub paths resolve from `--cwd`, as the CLI reference states. They are the
    // operator's dry-run inputs, not part of the workflow's source, so `--workflow-source`
    // must not silently move where they are read from or written to.
    const stubsPath = options.stubsPath
      ? isAbsolute(options.stubsPath)
        ? options.stubsPath
        : join(cwd, options.stubsPath)
      : undefined;
    const stubsInitPath = options.stubsInitPath
      ? isAbsolute(options.stubsInitPath)
        ? options.stubsInitPath
        : join(cwd, options.stubsInitPath)
      : undefined;
    if (stubsInitPath !== undefined) {
      const scaffold = await writeDryRunStubScaffold(workflow, stubsInitPath);
      const nodeCount = Object.keys(scaffold).length;
      if (options.json) {
        await writeJsonLine({ workflow: workflow.name, stubsPath: stubsInitPath, nodeCount });
      } else {
        await writeStdout(
          `Created dry-run stub scaffold for ${workflow.name}: ${stubsInitPath} (${String(nodeCount)} nodes)\n`
        );
      }
      return;
    }
    const stubs = await loadDryRunStubs(stubsPath);
    // The install's config + AI profile are what make the per-node provider/model report
    // match a real run — tier keywords and `@alias` refs resolve through the same profile
    // the executor builds.
    //
    // NOT wrapped in a catch: `loadConfig` returns defaults when there is no config file,
    // so a throw means a malformed or unreadable one. Reporting against fabricated
    // defaults would hand the user a clean-looking trace of a run that cannot happen —
    // the same fail-fast reasoning the container-policy load below spells out.
    // The target workspace, never the authoring root: `--exec-code` runs real bash and
    // script nodes, and running them in the checkout the workflow was merely READ from
    // would mutate the author's tree instead of the one they aimed the dry run at.
    const dryRunFileConfig = await loadConfig(cwd);
    const dryRunConfig = applyWorkflowRunConfigLayer(dryRunFileConfig, runConfig?.layer);
    const dryRunUserPrefs = await resolveCliDryRunAiPrefs();
    let dryRunDefaultProvider =
      runConfig?.layer.assistant ?? dryRunUserPrefs.defaultProvider ?? dryRunFileConfig.assistant;
    let dryRunProfileOptions: BuildAiProfileOptions = {
      repoTiers: dryRunFileConfig.tiers,
      repoAliases: dryRunFileConfig.aliases,
      userTiers: dryRunUserPrefs.tiers,
      userAliases: dryRunUserPrefs.aliases,
      runTiers: runConfig?.layer.tiers,
      runAliases: runConfig?.layer.aliases,
    };
    let dryRunBaseProfile: ResolvedAiProfile;
    try {
      dryRunBaseProfile = buildAiProfile(dryRunDefaultProvider, dryRunProfileOptions);
    } catch (error) {
      getLog().error({ err: error as Error }, 'cli.dry_run_user_ai_prefs_profile_invalid');
      dryRunDefaultProvider = runConfig?.layer.assistant ?? dryRunFileConfig.assistant;
      dryRunProfileOptions = {
        repoTiers: dryRunFileConfig.tiers,
        repoAliases: dryRunFileConfig.aliases,
        runTiers: runConfig?.layer.tiers,
        runAliases: runConfig?.layer.aliases,
      };
      dryRunBaseProfile = buildAiProfile(dryRunDefaultProvider, dryRunProfileOptions);
    }
    const dryRunModelOverrides = resolveRunModelOverrides(dryRunBaseProfile, modelOverrides);
    const result = await dryRunWorkflow({
      workflow,
      userMessage,
      cwd,
      stubs,
      ...(dryRunInputs ? { inputs: dryRunInputs } : {}),
      execCode: options.execCode,
      defaultStubs: options.defaultStubs,
      pauseAtGates: options.pauseAtGates,
      config: dryRunConfig,
      aiProfile: applyResolvedRunModelOverrides(dryRunBaseProfile, dryRunModelOverrides),
    });
    if (options.json) {
      await writeJsonLine(result);
    } else {
      await writeStdout(`${formatDryRunTrace(result)}\n`);
    }
    if (result.outcome === 'failed') {
      // Same filter `checkFixture` applies: a stub an `all_done` join tolerated
      // never blocked anything, so naming it as a cause of this failure points
      // the reader at the wrong node (#2869).
      const blockingMissingStubs = result.missingStubs.filter(
        nodeId => !result.toleratedMissingStubs.includes(nodeId)
      );
      throw new Error(
        blockingMissingStubs.length > 0
          ? `Dry-run failed; missing stubs: ${blockingMissingStubs.join(', ')}`
          : 'Dry-run failed. See the trace for details.'
      );
    }
    return;
  }

  // Validate mutually exclusive flags (defensive — cli.ts checks these for UX, but
  // workflowRunCommand is the authoritative boundary for programmatic callers)
  if (options.branchName !== undefined && options.noWorktree) {
    throw new Error(
      '--branch and --no-worktree are mutually exclusive.\n' +
        '  --branch creates an isolated worktree (safe).\n' +
        '  --no-worktree runs directly in your repo (no isolation).\n' +
        'Use one or the other.'
    );
  }
  if (options.noWorktree && options.fromBranch !== undefined) {
    throw new Error(
      '--from/--from-branch has no effect with --no-worktree.\n' +
        'Remove --from or drop --no-worktree.'
    );
  }
  if (options.noWorktree && options.baseBranch !== undefined) {
    throw new Error(
      '--base has no effect with --no-worktree.\n' + 'Remove --base or drop --no-worktree.'
    );
  }
  if (options.resume && options.branchName !== undefined) {
    throw new Error(
      '--resume and --branch are mutually exclusive.\n' +
        '  --resume reuses the existing worktree from the failed run.\n' +
        '  Remove --branch when using --resume.'
    );
  }
  if (options.resume && options.inputs !== undefined && options.inputs.length > 0) {
    throw new Error(
      '--resume and --input are mutually exclusive.\n' +
        "  A resume replays the original invocation's inputs, recorded on the run.\n" +
        '  Drop --input to resume, or start a fresh run to supply different values.'
    );
  }

  // Between-run continuation (#2747): adoption dictates the lane itself, so the
  // lane-choosing flags are refused rather than silently overridden.
  if (options.adoptRunId !== undefined) {
    const conflicts: string[] = [];
    if (options.resume) conflicts.push('--resume');
    if (options.branchName !== undefined) conflicts.push('--branch');
    if (options.fromBranch !== undefined) conflicts.push('--from/--from-branch');
    if (options.baseBranch !== undefined) conflicts.push('--base');
    if (options.noWorktree) conflicts.push('--no-worktree');
    if (conflicts.length > 0) {
      throw new Error(
        `--adopt and ${conflicts.join('/')} are mutually exclusive.\n` +
          '  Adoption resolves its own lane: reuse the adopted worktree, or cut a fresh one from its branch.'
      );
    }
  } else if (options.supersedesRunId !== undefined && options.resume) {
    throw new Error(
      '--supersedes records a FRESH-lane rerun as replacing a prior open item; it cannot be combined with --resume.'
    );
  }

  // Per-dispatch --base override, normalized once. Wins over repo config + the
  // codebase default for both the worktree cut-from (the provider request's
  // `baseOverride` below) and the PR target / $BASE_BRANCH (executeWorkflow's
  // `baseOverride` opt). Both halves need their own channel: the `baseBranch`
  // field on either side is the codebase-default FALLBACK and ranks below repo
  // config, so routing the flag through it would silently lose to a repo that
  // sets `worktree.baseBranch`.
  const flagBase = options.baseBranch?.trim() || undefined;

  // Reconcile workflow-level worktree policy with invocation flags.
  // The workflow YAML's `worktree.enabled` pins isolation regardless of caller —
  // a mismatch between policy and flags is a user error we surface loudly
  // rather than silently applying one side and ignoring the other.
  const pinnedEnabled = workflow.worktree?.enabled;
  if (pinnedEnabled === false) {
    if (options.branchName !== undefined) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: false (runs in live checkout).\n` +
          '  --branch requires an isolated worktree.\n' +
          "  Drop --branch or change the workflow's worktree.enabled."
      );
    }
    if (options.fromBranch !== undefined) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: false (runs in live checkout).\n` +
          '  --from/--from-branch only applies when a worktree is created.\n' +
          "  Drop --from or change the workflow's worktree.enabled."
      );
    }
    if (options.baseBranch !== undefined) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: false (runs in live checkout).\n` +
          '  --base only applies when a worktree is created.\n' +
          "  Drop --base or change the workflow's worktree.enabled."
      );
    }
    // --no-worktree is redundant but not contradictory — silently accept.
  } else if (pinnedEnabled === true) {
    if (options.noWorktree) {
      throw new Error(
        `Workflow '${workflow.name}' sets worktree.enabled: true (requires a worktree).\n` +
          '  --no-worktree conflicts with the workflow policy.\n' +
          "  Drop --no-worktree or change the workflow's worktree.enabled."
      );
    }
  }

  // Default to worktree isolation unless --no-worktree or --resume. Workflow YAML
  // `worktree.enabled` pins the decision — mismatches with CLI flags are rejected
  // above, so by this point policy (if set) and flags agree. `--resume` reuses an
  // existing worktree and takes precedence over the pinned policy. Computed here
  // (not at the worktree block below) because --detach also needs it to decide
  // whether to pin a generated branch on the child.
  const flagWantsIsolation = !options.resume && !options.noWorktree;
  // Reassigned by adoption resolution (#2747): adopting a branch whose worktree
  // is gone forces isolation ON to cut a fresh worktree FROM that branch.
  let wantsIsolation =
    !options.resume && pinnedEnabled !== undefined ? pinnedEnabled : flagWantsIsolation;

  // Worktree options require a git repo. When the caller explicitly declares
  // folder intent via --folder, reject --branch/--from and worktree-pinned
  // workflows synchronously (no DB needed). The authoritative kind-based guard
  // for ALREADY-registered folder projects (no --folder flag) lives after the
  // codebase lookup below. Fail fast — never silently ignore the flags.
  assertNoWorktreeOptionsForFolder(options.folder === true, options);
  assertWorkflowNotWorktreePinnedForFolder(options.folder === true, pinnedEnabled, workflow.name);

  // Signature gate (#2470, #2554): resolve this invocation's declared inputs from the
  // `--input name=value` flags against the workflow's `inputs:` block, here — before the
  // --detach fork and any worktree/clone/AI cost — so a bad name, a missing required
  // input, or a malformed assignment costs nothing.
  //
  // Skipped on --resume: the resumable run is not resolved until later in this function,
  // and its inputs were validated when its row was created. Re-gating with nothing
  // supplied would make every resume of a required-input run impossible.
  let resolvedInputs: Record<string, string> | undefined;
  if (!options.resume) {
    resolvedInputs = resolveTopLevelInputs(
      workflow,
      options.inputs ? parseInputAssignments(options.inputs) : undefined
    );
  }

  // Capability gate: hard-fail before the --detach fork and any worktree/clone/
  // AI cost if the workflow declares `requires: [github]` and the acting CLI
  // user hasn't connected. No-op on solo PAT installs. Mirrors the orchestrator
  // gate (dispatchOrchestratorWorkflow) so CLI, REST (via orchestrator), and
  // chat dispatch enforce `requires: [github]` identically.
  await assertCliWorkflowRequirementsMet(workflow);

  // --detach: hand the whole run to a detached background child and return now.
  // Done AFTER workflow resolution + flag validation above (so unknown-workflow /
  // bad-flag errors surface synchronously to the caller, not lost in the child)
  // and before any *worktree* work (the child creates the worktree). A read-only
  // codebase lookup does happen here — see the folder-detection probe below —
  // to decide folder-vs-repo branch pinning before forking.
  if (options.detach) {
    // Interactive-class refusal (#2707 step 2): a detached FRESH launch pauses with
    // nobody watching and nothing to resume it — the exact #1991 hang. Checked here,
    // synchronously, before the fork and before any worktree/clone/AI cost, mirroring
    // the requirements gate immediately above. Two checks, like the orchestrator's
    // shared background-dispatch gate (dispatchBackgroundWorkflowOwned): the
    // workflow's own declared class, and a gate that arrived via `include:` in a
    // workflow that omits `interactive: true` (the class declaration alone cannot see
    // that case — see assertComposedGateDriveable's doc comment).
    //
    // Scoped to a genuinely FRESH dispatch (`!isContinuation`) — refusing this at
    // "launch" only, per the issue's own wording. A run that has ALREADY proved it can
    // pause (it paused once) is not launching; `resume <id> --detach` and `run --resume
    // --detach` are legitimate continuation actions that must keep working, since the
    // whole point of --detach on those is to drive one gate and let a background
    // process continue to the next. If it pauses again, it sits paused again —
    // discoverable via `workflow status`/`runs`, not a silent hang nobody knows exists.
    if (!isContinuation) {
      assertInteractiveClassNotBackgrounded(workflow);
      // Already-expanded — discoverWorkflowsWithConfig's output never contains an
      // IncludeDirective (#2486); the type admits one only for the pre-expansion display
      // shape (`WorkflowWithSource.declared`), which `workflow` here is not.
      assertComposedGateDriveable(workflow.nodes as DagNode[]);
    }

    const childConversationId = options.conversationId ?? generateConversationId();
    const extraArgs: string[] = [];
    let pinnedBranch: string | undefined;

    // Everything from here to the fork is the pre-flight (#2872). It exists because
    // a detached launch used to print `Started` before anything that can be refused
    // deterministically had been checked: the child then died on adoption resolution,
    // no run row was ever written, and the only trace was a line inside the child's
    // log. A launch either produces a run id somebody can query, or it fails right
    // here with a non-zero exit. The fork itself has not moved — no worktree, clone,
    // or AI cost happens in this process.
    //
    // The project lookup was a best-effort folder probe; it is now the same resolution
    // the run path performs, because the run row needs `codebase_id` and adoption
    // cannot be judged without it. Registration is idempotent, so the child's own call
    // finds what this one registered.
    const detachResolved = await resolveRunCodebase(cwd, options);
    const detachCodebase = detachResolved.codebase;
    // Never on `--json`: stdout carries one machine-readable document and nothing else.
    if (detachResolved.registeredFolder && !options.json) {
      console.log(
        `Registered folder project "${detachResolved.registeredFolder.name}" ` +
          `(${detachResolved.registeredFolder.defaultCwd})`
      );
    }
    if (options.folder && !detachCodebase && detachResolved.registrationError) {
      throw buildFolderRegistrationFailureError(detachResolved.registrationError);
    }
    // The refusal the plain `run <name> --detach` launch was still missing: an isolating
    // run with no project to isolate. The isolation block enforces it in whichever
    // process reaches it, which for a detached launch is the child — after the parent has
    // already printed `Started` (#2872). `options.noWorktree` first, mirroring the
    // isolation block's own branch order.
    if (!options.noWorktree && wantsIsolation) {
      assertCodebaseResolvedForIsolation(detachResolved);
    }
    // Never pin a worktree branch on the child for a folder project. The --folder flag
    // declares it; an already-registered folder project is read off the resolution.
    const detachIsFolder = options.folder === true || detachCodebase?.kind === 'folder';
    // Surface worktree-option conflicts synchronously in the parent rather than
    // letting the child fail after fork.
    assertNoWorktreeOptionsForFolder(detachIsFolder, options);

    // Between-run continuation (#2747): refuse an unresolvable declaration HERE — this
    // is the exact failure that vanished into a child log. `resolveWorkflowAdoption` is
    // pure resolution with no filesystem or database mutation, so running it as a
    // pre-flight costs nothing and the child still re-resolves it against the live
    // checkout when it starts (its lane binds a worktree this process never touches).
    let adoptedRunId: string | undefined;
    let supersededRunId: string | undefined;
    if (options.adoptRunId !== undefined || options.supersedesRunId !== undefined) {
      if (!detachCodebase) {
        throw new Error(
          'Cannot resolve the project for --adopt/--supersedes. Run from the project checkout and try again.'
        );
      }
      if (options.adoptRunId !== undefined) {
        adoptedRunId = await resolveRunIdArg(options.adoptRunId, cwd, false, detachCodebase.id);
        await resolveWorkflowAdoption({
          adoptedRunId,
          codebaseId: detachCodebase.id,
          codebasePath: detachCodebase.default_cwd,
          codebaseKind: detachCodebase.kind,
          containerRequested: options.container === true,
        });
      } else if (options.supersedesRunId !== undefined) {
        supersededRunId = await resolveRunIdArg(
          options.supersedesRunId,
          cwd,
          false,
          detachCodebase.id
        );
        await resolveSupersededRun(supersededRunId);
      }
    }

    // The run id the ack hands back. A continuation already has one; a fresh launch
    // gets a row written below, before the fork.
    let detachedRunId: string;
    // Only a row THIS process created may be failed when the child never takes it.
    // A continuation's row belongs to its own run.
    let launchedRunId: string | undefined;
    if (isContinuation) {
      if (resumeLookupError) throw buildResumeLookupFailureError(resumeLookupError);
      if (!continuationRun) throw buildNoResumableRunError(workflowName, cwd);
      detachedRunId = continuationRun.id;
    } else {
      // `Started` must mean a queryable run, so the row is written before the fork and
      // the child executes it rather than creating its own. Modeled on the
      // orchestrator's pre-created row (dispatchBackgroundWorkflowOwned), including
      // the stamps the executor only writes when IT creates the row. `working_path` is
      // the one field this process cannot know — the child cuts the worktree — so it
      // stays null until the child fills it in (write-once in the store).
      let detachedConversation;
      try {
        detachedConversation = await conversationDb.getOrCreateConversation(
          'cli',
          childConversationId
        );
      } catch (error) {
        const err = error as Error;
        throw new Error(
          `Failed to access database: ${err.message}\nHint: Check that DATABASE_URL is set and the database is running.`
        );
      }
      const detachedUserId = await resolveCliUserRecordId();
      const continuationDeclaration =
        adoptedRunId !== undefined
          ? { mode: 'adopt' as const, runId: adoptedRunId }
          : supersededRunId !== undefined
            ? { mode: 'supersede' as const, runId: supersededRunId }
            : undefined;
      try {
        // No reserved id: this process's own capture is discarded on the way out, and
        // reusing its id would point the child's capture at a directory this process is
        // about to reclaim. The row's generated id is what the child files under.
        const created = await workflowDb.createWorkflowRun({
          workflow_name: workflow.name,
          conversation_id: detachedConversation.id,
          ...(detachCodebase ? { codebase_id: detachCodebase.id } : {}),
          user_message: userMessage,
          metadata: {
            // Declared inputs (#2554): `$INPUTS` is read off the row, so a pre-created
            // row that omits them starts a run whose inputs silently disappeared.
            ...(resolvedInputs && Object.keys(resolvedInputs).length > 0
              ? { [SUBRUN_METADATA_KEYS.inputs]: { ...resolvedInputs } }
              : {}),
            ...(continuationDeclaration
              ? { [CONTINUATION_METADATA_KEY]: { mode: continuationDeclaration.mode } }
              : {}),
          },
          ...(detachedUserId ? { user_id: detachedUserId } : {}),
          ...(continuationDeclaration
            ? { adopted_from_run_id: continuationDeclaration.runId }
            : {}),
        });
        detachedRunId = created.id;
        launchedRunId = created.id;
      } catch (error) {
        throw new Error(
          `Failed to create the workflow run: ${(error as Error).message}\nNothing was started.`
        );
      }
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
    // Pin the conversation id only when generated (an explicit one is already in argv).
    if (options.conversationId === undefined) {
      extraArgs.push('--conversation-id', childConversationId);
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
    const runConfigPayload = runConfig
      ? JSON.stringify(sealWorkflowRunConfig(runConfig.layer, runConfig.source))
      : undefined;
    let logPath: string | null;
    try {
      logPath = await spawnDetachedWorkflowRun(
        cwd,
        childConversationId,
        extraArgs,
        runConfigPayload
      );
    } catch (error) {
      // The child never took the run — it failed to spawn, or died inside the startup
      // window. This process is the row's only owner until the child claims it, so it
      // records why instead of leaving a `pending` row nobody can explain.
      if (launchedRunId !== undefined) {
        await workflowDb
          .failWorkflowRun(launchedRunId, `Detached launch failed: ${(error as Error).message}`)
          .catch((dbError: Error) => {
            getLog().error(
              { err: dbError, workflowRunId: launchedRunId },
              'cli.detached_launch_failure_record_failed'
            );
          });
      }
      throw error;
    }

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
        conversationId: childConversationId,
        logPath,
      });
    } else {
      console.log(`Started '${workflow.name}' in the background.`);
      console.log(`Run id: ${detachedRunId}`);
      console.log(`Track it with: archon workflow get ${detachedRunId}`);
      if (logPath) {
        console.log(`Child output: ${logPath}`);
      } else {
        // Log file couldn't be opened — the child runs with its output discarded, so a
        // failure after the startup window leaves no trail beyond the run row itself.
        console.warn('Warning: could not open a log file — child output will not be captured.');
      }
    }
    return;
  }

  console.log(`Running workflow: ${workflowName}`);
  console.log(`Working directory: ${cwd}`);
  console.log('');

  // Create CLI adapter
  const adapter = new CLIAdapter();

  // Generate conversation ID
  const conversationId = options.conversationId ?? generateConversationId();

  // Get or create conversation in database
  let conversation;
  try {
    conversation = await conversationDb.getOrCreateConversation('cli', conversationId);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to access database: ${err.message}\nHint: Check that DATABASE_URL is set and the database is running.`
    );
  }

  const {
    codebase,
    lookupError: codebaseLookupError,
    registrationError: codebaseRegistrationError,
    registeredFolder,
  } = await resolveRunCodebase(cwd, options);
  if (registeredFolder) {
    console.log(
      `Registered folder project "${registeredFolder.name}" (${registeredFolder.defaultCwd})`
    );
  }

  // A --folder registration failure must be fatal regardless of the workflow's
  // worktree policy. Otherwise, for a `worktree.enabled: false` workflow (e.g.
  // the bundled `archon-assist`, the flagship `--folder` example), wantsIsolation
  // is false, so the later isolation fail-fast branch never fires and the run
  // would silently proceed against the bare cwd with no registered project.
  if (options.folder && !codebase && codebaseRegistrationError) {
    throw buildFolderRegistrationFailureError(codebaseRegistrationError);
  }

  // Handle isolation (worktree creation)
  let workingCwd = cwd;
  let isolationEnvId: string | undefined;
  // Execution context for the run. Repo/worktree and folder-in-place both run on
  // the host; the folder-backend seam sets this and is where `--container` flips
  // it to a container context.
  let execContext: ExecutionContext = { kind: 'host' };
  // Container backend handle for a folder-project container run — held so the CLI
  // tears it down after a TERMINAL run (a PAUSED run keeps its suspended container
  // for resume). The engine drives suspend + the write-back gate through the same
  // backend via `opts.container`; the CLI only prepares/resumes and destroys.
  let containerBackend: ContainerBackend | undefined;
  let containerEnvId: string | undefined;
  // Overlay mode the backend actually mounted (fuse = unprivileged; native =
  // CAP_SYS_ADMIN, gate-bypassable). Threaded to the engine for the H4 run-start warning.
  let containerOverlayMode: 'fuse' | 'native' | undefined;

  // Between-run continuation (#2747): resolve the declared adoption BEFORE any
  // lane decision — it dictates the lane, fail-loud (never a silent fresh
  // start). Supersede validates existence/terminality only; it deliberately
  // inherits nothing.
  let adoptedFromRunId: string | undefined;
  let adoptedTaskBranch: Extract<TaskBranchSelection, { kind: 'existing' }> | undefined;
  let continuationMode: ContinuationMode | undefined;
  // Set when the adopt lane executes inside a checkout whose `.archon` may differ from
  // this process's cwd — the trigger for recaptureForLane once the path is final.
  let adoptLaneRunsIsolatedCheckout = false;
  if (options.adoptRunId !== undefined || options.supersedesRunId !== undefined) {
    if (!codebase) {
      throw new Error(
        'Cannot resolve the project for --adopt/--supersedes. Run from the project checkout and try again.'
      );
    }
    // Narrowed by construction: the flag-conflict gate above guarantees exactly
    // one of the two ids is present.
    if (options.adoptRunId !== undefined) {
      continuationMode = 'adopt';
      adoptedFromRunId = await resolveRunIdArg(options.adoptRunId, cwd, false, codebase.id);
    } else if (options.supersedesRunId !== undefined) {
      continuationMode = 'supersede';
      adoptedFromRunId = await resolveRunIdArg(options.supersedesRunId, cwd, false, codebase.id);
    } else {
      throw new Error('--adopt/--supersedes requires a run id.');
    }

    if (continuationMode === 'adopt') {
      const { adoptedRun, lane } = await resolveWorkflowAdoption({
        adoptedRunId: adoptedFromRunId,
        codebaseId: codebase.id,
        codebasePath: codebase.default_cwd,
        codebaseKind: codebase.kind,
        containerRequested: options.container === true,
      });
      if (lane.kind === 'reuse-worktree') {
        workingCwd = lane.workingPath;
        isolationEnvId = lane.envId;
        adoptLaneRunsIsolatedCheckout = true;
        // The reuse lane IS the isolation: run in the inherited worktree as-is.
        // Leaving wantsIsolation set would fall through to worktree creation below
        // and silently cut a fresh worktree from base over the inherited one.
        wantsIsolation = false;
        console.log(
          `Adopting run ${adoptedRun.id} — reusing its worktree at ${lane.workingPath} (dirty state inherited as-is).`
        );
      } else if (lane.kind === 'checkout-branch') {
        adoptedTaskBranch = lane.taskBranch;
        wantsIsolation = true;
        adoptLaneRunsIsolatedCheckout = true;
        console.log(
          `Adopting run ${adoptedRun.id} — its worktree is gone; checking out its existing branch '${lane.taskBranch.branch}'.`
        );
      } else {
        console.log(
          `Adopting run ${adoptedRun.id} — folder projects run in place; adoption carries provenance and $ADOPTED_RUN_DIR access only.`
        );
      }
    } else {
      const superseded = await resolveSupersededRun(adoptedFromRunId);
      console.log(`Superseding run ${superseded.id} — fresh lane, provenance recorded.`);
    }
  }

  // Handle --resume: locate the prior failed run, reuse its worktree, and hand
  // the resumed-run handle to executeWorkflow below via opts. The executor no
  // longer performs implicit resume detection on its own.
  let resumable: WorkflowRun | null = null;
  if (options.resume) {
    if (!codebase) {
      if (codebaseLookupError) {
        throw new Error(
          'Cannot resume: Database lookup failed.\n' +
            `Error: ${codebaseLookupError.message}\n` +
            'Hint: Check your database connection before using --resume.'
        );
      }
      if (codebaseRegistrationError) {
        throw buildRegistrationFailureError('resume', codebaseRegistrationError);
      }
      throw new Error(
        'Cannot resume: Not in a git repository.\n' +
          'Either run from a git repo or use /clone first.'
      );
    }

    if (resumeLookupError) {
      throw buildResumeLookupFailureError(resumeLookupError);
    }
    // Resolved before discovery (top of this function), because the graph this run
    // executes had to be chosen from it.
    resumable = continuationRun ?? null;

    if (!resumable) {
      throw buildNoResumableRunError(workflowName, cwd);
    }

    getLog().info(
      {
        workflowRunId: resumable.id,
        workflowName,
        workingPath: resumable.working_path,
      },
      'workflow.resume_found_resumable'
    );

    // A container run IS resumable (Phase C): the overlay lives on a persisted
    // volume the resume rediscovers and restarts (see the folder branch below,
    // which calls backend.resumeEnv when `resumable.metadata.isolation` is
    // 'container'). Nothing to reject here anymore.

    // Reuse the working path from the resumable run (verify it still exists)
    if (resumable.working_path) {
      const { existsSync } = await import('fs');
      if (!existsSync(resumable.working_path)) {
        throw new Error(
          `Cannot resume: the working path from the run no longer exists: ${resumable.working_path}\n` +
            'The worktree may have been cleaned up. Start a fresh run with --branch instead.'
        );
      }
      workingCwd = resumable.working_path;
    }

    // Look up the isolation environment that owns this working path (if any)
    const allEnvs = await isolationDb.listByCodebase(codebase.id);
    const matchingEnv = allEnvs.find(e => e.working_path === workingCwd);
    if (matchingEnv) {
      isolationEnvId = matchingEnv.id;
      getLog().info(
        { envId: isolationEnvId, workingPath: workingCwd },
        'workflow.resume_env_found'
      );
    }

    console.log(`Resuming workflow run: ${resumable.id}`);
    console.log(`Working path: ${workingCwd}`);
    console.log('');

    // --resume adopts the prior run's worktree, so --base is half-applied here
    // exactly as it is on --branch reuse above: the cut-from is already fixed,
    // but flagBase still rides opts.baseOverride into $BASE_BRANCH.
    if (flagBase) {
      warnBaseOverrideOnReuse(workingCwd, flagBase);
    }
  }

  const isFolderCodebase = codebase?.kind === 'folder';

  // Container isolation is folder-project-only in v1. A repo-kind project (or a
  // bare git repo / unregistered non-git cwd) with --container fails fast rather
  // than silently running a worktree/in-place — no surprising isolation downgrade.
  if (options.container && !isFolderCodebase) {
    throw new Error(
      'Container isolation is folder-project-only for now. Run --container against a ' +
        'registered folder project (or add --folder to register this directory as one). ' +
        'Repo projects use worktree isolation.'
    );
  }

  // The codebase's stored default branch, used as the base-branch fallback when
  // repo config sets no worktree.baseBranch (reuse validation, worktree
  // creation, and $BASE_BRANCH resolution all derive from this one value).
  const codebaseDefaultBranch = codebase?.default_branch?.trim() || undefined;

  // Authoritative folder guards for an already-registered folder project run
  // WITHOUT the --folder flag (the flag-based guards above only fire when the
  // caller declared intent). Fail fast before any worktree work.
  assertNoWorktreeOptionsForFolder(isFolderCodebase, options);
  assertWorkflowNotWorktreePinnedForFolder(isFolderCodebase, pinnedEnabled, workflow.name);

  if (isFolderCodebase && codebase) {
    // Folder projects run through the folder-backend seam — no worktree isolation.
    // The in-place backend (default) keeps the agent's cwd at the folder root, so
    // it sees every child folder/repo, and per-service git (branch/commit/PR) is
    // the agent's job via bash/gh. The container backend (--container / config)
    // instead runs everything inside an overlay-isolated container.
    const folderCodebase = {
      id: codebase.id,
      defaultCwd: codebase.default_cwd,
      name: codebase.name,
      kind: 'folder' as const,
    };

    // Selection precedence: --container flag > workflow container.enabled >
    // config container.enabled (default off). Do NOT swallow loadConfig errors:
    // a malformed/unreadable config that would carry `container.*` policy must
    // FAIL the run, never silently downgrade to an in-place host run (fail-fast).
    // loadConfig returns defaults when no config file exists (not an error).
    //
    // On a RESUME (approve/reject/resume re-enter with `{ resume: true }` and no
    // --container flag), honor the ORIGINAL run's isolation via its stamped
    // metadata — never re-derive from the flag/config, or a resume could silently
    // switch a container run to in-place on the live root.
    const folderConfig = await loadConfig(codebase.default_cwd);
    const wantsContainer = options.resume
      ? resumable?.metadata?.isolation === 'container'
      : (options.container ??
        workflow.container?.enabled ??
        folderConfig?.container?.enabled ??
        false);

    if (wantsContainer) {
      const containerConfig = resolveContainerBackendConfig(folderConfig?.container);
      const backend = resolveFolderBackend(folderCodebase, {
        container: true,
        store: isolationDb.createIsolationStore(),
        containerConfig,
      });
      let prepared;
      if (options.resume) {
        // Rediscover + restart the container for this run: `docker start` a
        // suspended container, or recreate one over the persisted upper volume
        // (the accumulated overlay is preserved). The env id was stamped into the
        // run metadata at first-run creation. resumeEnv fails LOUD if the volume
        // is gone (un-applied work lost) rather than restarting from empty.
        //
        // Ordering (L3): the container is restarted FIRST (here) even on a
        // write-back-only resume where no DAG node will re-execute — kept uniform
        // with the mid-DAG-approval resume, which DOES need a live container. The
        // subsequent write-back apply runs in an INDEPENDENT `docker run` helper
        // over the volume (see overlay.ts), so it neither needs nor races the
        // restarted run container.
        const resumeEnvId =
          typeof resumable?.metadata?.isolation_env_id === 'string'
            ? resumable.metadata.isolation_env_id
            : undefined;
        if (!resumeEnvId) {
          throw new Error(
            `Cannot resume container run '${resumable?.id ?? '?'}': its isolation env id is ` +
              'missing from the run metadata. Start a fresh --container run instead.'
          );
        }
        console.log(`Folder project — resuming container run (image ${containerConfig.image}).`);
        getLog().info(
          { envId: resumeEnvId, image: containerConfig.image },
          'workflow.resuming_in_container'
        );
        try {
          prepared = await backend.resumeEnv(resumeEnvId);
        } catch (resumeErr) {
          const err = resumeErr as Error;
          getLog().error({ err, envId: resumeEnvId }, 'workflow.container_resume_failed');
          throw new Error(classifyIsolationError(err));
        }
      } else {
        console.log(`Folder project — running in container (image ${containerConfig.image}).`);
        getLog().info(
          { cwd: codebase.default_cwd, image: containerConfig.image },
          'workflow.running_in_container'
        );
        try {
          // The container fixes its mounts at creation, so the run's source must already
          // be at its final path. Move it there now; executeWorkflow recomputes the same
          // destination and skips its own move.
          if (preparedSource) {
            preparedSource = await finalizeWorkflowSource(createWorkflowDeps(), preparedSource, {
              cwd: folderCodebase.defaultCwd,
              codebaseId: folderCodebase.id,
            });
            // Finalization moved the capture, so keep ownership on the path that now
            // exists. If container preparation fails below, the wrap reclaims the
            // finalized capture instead of the already-renamed staging path.
            owner.hold(preparedSource);
          }
          prepared = await backend.prepare({
            codebase: folderCodebase,
            // Read-only, at the same absolute path inside the container, so a named
            // script resolves identically on both sides of the boundary.
            ...(preparedSource ? { sourceMount: preparedSource.captureRoot } : {}),
          });
        } catch (prepErr) {
          // Map docker/daemon/image failures to an actionable message (daemon down,
          // runner image missing, docker-group permission — see errors.ts).
          const err = prepErr as Error;
          getLog().error({ err, codebaseId: codebase.id }, 'workflow.container_prepare_failed');
          throw new Error(classifyIsolationError(err));
        }
      }
      // The container mounts the overlay at the SAME absolute path (same-absolute-
      // path invariant), so prepared.cwd is the folder root. Consume it explicitly
      // rather than assuming workingCwd — the container backend returns a
      // container-side cwd, unlike in-place.
      workingCwd = prepared.cwd;
      execContext = prepared.execContext;
      containerBackend = backend;
      containerEnvId = prepared.envId;
      containerOverlayMode = prepared.overlayMode;
      isolationEnvId = prepared.envId;
    } else {
      // In-place (default) — byte-identical to pre-container behavior: keep
      // workingCwd, only annotate the host execContext.
      console.log('Folder project — running in place (no worktree isolation).');
      getLog().info({ cwd: workingCwd }, 'workflow.running_without_isolation');
      const backend = resolveFolderBackend(folderCodebase, { container: false });
      const prepared = await backend.prepare({ codebase: folderCodebase });
      execContext = prepared.execContext;
    }
  } else if (wantsIsolation && codebase) {
    // Auto-generate branch identifier from workflow name + timestamp when --branch not provided
    const branchIdentifier = options.branchName ?? `${workflowName}-${Date.now()}`;

    // Configure isolation with repo config loader (same as orchestrator)
    configureIsolation(async (repoPath: string) => {
      const repoConfig = await loadRepoConfig(repoPath);
      return repoConfig?.worktree ?? null;
    });

    const provider = getIsolationProvider();

    // Check for existing worktree (only when explicit --branch)
    const existingEnv = options.branchName
      ? await isolationDb.findActiveByWorkflow(codebase.id, 'task', options.branchName)
      : undefined;

    if (existingEnv && (await provider.healthCheck(existingEnv.working_path))) {
      if (options.fromBranch) {
        getLog().warn(
          { path: existingEnv.working_path, fromBranch: options.fromBranch },
          'worktree.reuse_from_branch_ignored'
        );
        console.warn(
          `Warning: Reusing existing worktree at ${existingEnv.working_path}. ` +
            `--from ${options.fromBranch} was not applied (worktree already exists).`
        );
      }
      if (flagBase) {
        warnBaseOverrideOnReuse(existingEnv.working_path, flagBase);
      }
      // Validate base branch before reuse (warning-only — non-blocking)
      try {
        const repoConfig = await loadRepoConfig(codebase.default_cwd);
        const rawBase = repoConfig?.worktree?.baseBranch?.trim();
        // Four-level fallback: --base override → repo config → codebase default →
        // git auto-detect. Mirrors WorktreeProvider and executeWorkflow, so the
        // reuse check validates against the base this dispatch actually asked
        // for instead of reporting a mismatch nobody requested.
        let configuredBase: git.BranchName;
        if (flagBase) {
          configuredBase = git.toBranchName(flagBase);
        } else if (rawBase) {
          configuredBase = git.toBranchName(rawBase);
        } else if (codebaseDefaultBranch) {
          configuredBase = git.toBranchName(codebaseDefaultBranch);
        } else {
          configuredBase = await git.getDefaultBranch(git.toRepoPath(codebase.default_cwd));
        }
        const isValidBase = await git.isAncestorOf(
          git.toWorktreePath(existingEnv.working_path),
          `origin/${configuredBase}`
        );
        if (!isValidBase) {
          getLog().warn(
            { path: existingEnv.working_path, configuredBase, branch: existingEnv.branch_name },
            'worktree.reuse_base_branch_mismatch'
          );
          console.warn(
            `Warning: Worktree '${existingEnv.branch_name}' is not based on '${configuredBase}'. ` +
              `Recreate with: bun run cli complete ${existingEnv.branch_name} --force`
          );
        }
      } catch (e) {
        getLog().debug({ err: e }, 'worktree.reuse_base_branch_check_skipped');
        // Non-blocking — skip warning if base branch cannot be determined
      }
      getLog().info({ path: existingEnv.working_path }, 'worktree_reused');
      workingCwd = existingEnv.working_path;
      isolationEnvId = existingEnv.id;
    } else {
      // Create new worktree
      getLog().info(
        { branch: branchIdentifier, fromBranch: options.fromBranch },
        'worktree_creating'
      );

      const isolatedEnv = await provider.create({
        workflowType: 'task',
        identifier: branchIdentifier,
        taskBranch: adoptedTaskBranch
          ? adoptedTaskBranch
          : options.branchName
            ? {
                kind: 'new',
                branch: git.toBranchName(options.branchName),
                ...(options.fromBranch?.trim()
                  ? { fromBranch: git.toBranchName(options.fromBranch.trim()) }
                  : {}),
              }
            : options.fromBranch?.trim()
              ? { kind: 'new', fromBranch: git.toBranchName(options.fromBranch.trim()) }
              : undefined,
        baseBranch: codebaseDefaultBranch ? git.toBranchName(codebaseDefaultBranch) : undefined,
        baseOverride: flagBase ? git.toBranchName(flagBase) : undefined,
        codebaseId: codebase.id,
        // owner/repo name lets resolveOwnerRepo use the registered identity
        // instead of the _local/<basename> path fallback (#2022, #2227)
        codebaseName: codebase.name,
        canonicalRepoPath: git.toRepoPath(codebase.default_cwd),
        description: `CLI workflow: ${workflowName}`,
      });

      // Track in database
      const envRecord = await isolationDb.create({
        codebase_id: codebase.id,
        workflow_type: 'task',
        workflow_id: branchIdentifier,
        provider: 'worktree',
        working_path: isolatedEnv.workingPath,
        branch_name: isolatedEnv.branchName,
        created_by_platform: 'cli',
        metadata: {},
      });

      workingCwd = isolatedEnv.workingPath;
      isolationEnvId = envRecord.id;
      getLog().info({ path: workingCwd }, 'worktree_created');
    }
  } else if (options.noWorktree) {
    getLog().info({ cwd }, 'workflow.running_without_isolation');
  } else if (wantsIsolation) {
    // Isolation was expected (default) but codebase is unavailable — fail fast. The
    // `--detach` pre-flight enforces the same refusal before the fork.
    assertCodebaseResolvedForIsolation({
      codebase,
      lookupError: codebaseLookupError,
      registrationError: codebaseRegistrationError,
    });
  }

  // The lane's checkout is final here — reuse-worktree set it in the lane block, and
  // checkout-branch when the resolver materialized its exact branch above.
  if (adoptLaneRunsIsolatedCheckout) {
    console.log(`Capturing workflow source from ${workingCwd}.`);
    await recaptureForLane(workingCwd);
  }

  // Update conversation with cwd and isolation info
  try {
    await conversationDb.updateConversation(conversation.id, {
      cwd: workingCwd,
      codebase_id: codebase?.id ?? null,
      isolation_env_id: isolationEnvId ?? null,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to update conversation: ${err.message}`);
  }

  // Wire adapter for assistant message persistence
  adapter.setConversationDbId(conversationId, conversation.id);

  // Resolve the CLI user once (ARCHON_USER_ID, else $USER/$USERNAME). When set,
  // upsert via the `cli` platform identity so the same Archon user is reused
  // across invocations — this is what attributes the workflow run to the human
  // running the command and what `getUserProviderEnv` keys on for per-user
  // AI-provider credentials (#1891 Phase 2).
  const cliUserId = await resolveCliUserRecordId();

  // Persist user message for Web UI history.
  try {
    await messageDb.addMessage(conversation.id, 'user', userMessage, undefined, cliUserId);
  } catch (error) {
    getLog().warn(
      { err: error as Error, conversationId: conversation.id },
      'cli_user_message_persist_failed'
    );
  }

  // Auto-generate title for CLI workflow conversations (fire-and-forget)
  void (async (): Promise<void> => {
    let workflowConfig: Awaited<ReturnType<typeof loadConfig>> | undefined;
    try {
      workflowConfig = await loadConfig(cwd);
    } catch (error) {
      getLog().warn({ err: error as Error, cwd }, 'workflow.title_config_load_failed');
    }

    try {
      const titleAssistantType = resolveTitleAssistantType(
        workflowEntry?.declared,
        workflowConfig?.assistant,
        conversation.ai_assistant_type
      );
      const titleAssistantConfig = workflowConfig?.assistants?.[titleAssistantType] ?? {};
      await generateAndSetTitle(
        conversation.id,
        userMessage,
        titleAssistantType,
        workingCwd,
        workflowName,
        titleAssistantConfig
      );
    } catch (error) {
      getLog().warn(
        { err: error as Error, conversationId: conversation.id },
        'workflow.title_generation_failed'
      );
    }
  })();

  // Register cleanup handlers for graceful termination.
  //
  // Guard rails (#1123): a signal must only ever fail THE run this process is
  // driving, and only while that run is still 'running'. The run id is learned
  // from the resumable lookup (resume path), the row a detached parent handed
  // this child (#2872), or the workflow_started emitter event (fresh runs, see
  // the subscription below) — never from a
  // conversation-wide "active run" query, which can match a run driven by
  // another process (children share parent_conversation_id). When the run has
  // already transitioned elsewhere — paused at a gate, completed, cancelled —
  // the handler leaves it alone; see "No Autonomous Lifecycle Mutation Across
  // Process Boundaries" in CLAUDE.md. The handlers themselves are removed in
  // the finally below once executeWorkflow returns, so a late signal can never
  // touch a settled run (and repeated workflowRunCommand calls in one process
  // don't stack handlers).
  let ownedRunId: string | undefined = resumable?.id ?? detachedPreCreatedRun?.id;
  let detachedRunControl: Awaited<ReturnType<typeof startDetachedRunControlServer>> | undefined;
  if (detachedProcessOwner) {
    if (ownedRunId === undefined) {
      throw new Error('Detached workflow owner has no resolved run ID');
    }
    detachedRunControl = await startDetachedRunControlServer(ownedRunId);
  }
  let terminating = false;
  const cleanup = (signal: string): void => {
    if (terminating) return;
    terminating = true;
    getLog().info({ conversationId: conversation.id, signal }, 'workflow.process_terminating');
    const interruptedRunId = ownedRunId;
    (async (): Promise<void> => {
      if (!interruptedRunId) {
        // Signal before this process created/resumed a run — nothing it owns.
        // A pre-created 'pending' row is covered by the stale-pending hygiene.
        getLog().info(
          { conversationId: conversation.id, signal },
          'workflow.termination_no_owned_run'
        );
        return;
      }
      if (detachedRunControl?.isStopRequested()) {
        // The exact-run controller has proved ownership and is terminating this
        // process tree. It records `cancelled` only after termination succeeds;
        // do not race it by translating the operator's stop into generic failure.
        getLog().info(
          { runId: interruptedRunId, signal },
          'workflow.operator_stop_leaves_lifecycle_to_controller'
        );
        return;
      }
      const status = await workflowDb.getWorkflowRunStatus(interruptedRunId);
      if (status !== 'running') {
        // Externally transitioned (paused at a new gate, completed, cancelled,
        // failed) — not this handler's to mutate.
        getLog().info(
          { runId: interruptedRunId, status, signal },
          'workflow.termination_skip_not_running'
        );
        return;
      }
      // Genuine interrupt of the run this process is driving. failWorkflowRun's
      // own status='running' CAS closes the read-then-write window: if the
      // executor commits a gate pause between the read above and this write,
      // the CAS misses and throws (caught below) — the run stays paused.
      await workflowDb.failWorkflowRun(interruptedRunId, `Process terminated (${signal})`);
    })()
      .catch((err: unknown) => {
        const e = err as Error;
        getLog().error(
          { err: e, errorType: e.constructor.name },
          'workflow.termination_cleanup_failed'
        );
      })
      // Destroy the isolation container so Ctrl-C / SIGTERM doesn't orphan a
      // PRIVILEGED container — the forced exit below bypasses the teardown
      // `finally`, so we must tear it down explicitly here first.
      .then(async () => {
        if (containerBackend && containerEnvId) {
          try {
            await containerBackend.destroy(containerEnvId);
          } catch (destroyErr) {
            console.error(
              `\nWARNING: could not remove the isolation container on ${signal}: ` +
                `${(destroyErr as Error).message}. Remove it manually: ` +
                'docker ps -a --filter label=diy.archon.managed=true'
            );
          }
        }
      })
      // Reclaim the staged capture for the same reason the container is destroyed above:
      // the forced exit below never returns up the stack, so the ownership `finally` —
      // whose whole premise is "whichever way we leave" — never runs. Ctrl-C during
      // isolation resolution or worktree creation would otherwise strand a complete
      // frozen tree.
      //
      // The rm targets the ORIGINAL staged path pinned at prepare time, not
      // `preparedSource.captureRoot` (see `originalStagedRoot`'s note above).
      // For container runs that path was renamed away by `finalizeWorkflowSource`
      // and `preparedSource.captureRoot` is now the LIVE artifacts directory —
      // rm-ing it mid-execution would destroy the run's source.
      .then(async () => {
        if (originalStagedRoot) {
          await disposeWorkflowSource({ captureRoot: originalStagedRoot });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        // Route through the same drain helper cli.ts's top-level exit chain
        // uses so queued `console.log` output (this command streams progress
        // through 101 call sites) reaches a slow reader before the process
        // exits — a bare `process.exit(1)` here would reopen #2400's
        // truncation on Ctrl-C/SIGTERM specifically. See R16 in the review
        // report.
        void exitWithDrain(1);
      });
  };
  const sigtermHandler = (): void => {
    cleanup('SIGTERM');
  };
  const sigintHandler = (): void => {
    cleanup('SIGINT');
  };
  process.once('SIGTERM', sigtermHandler);
  process.once('SIGINT', sigintHandler);

  // One-time-per-version notice when the workflow uses unconfigured tier keywords.
  await maybePrintTierNotice(workflow, workingCwd, cliUserId, options.quiet);

  // Subscribe to workflow events: always registered (even with --quiet) because
  // the handler also learns the run id this process owns — the signal cleanup
  // guard above needs it for fresh runs, where the id only exists once
  // executeWorkflow creates the run and emits workflow_started. --quiet only
  // gates the progress rendering.
  // subscribeForConversation is pure in-memory registration — cannot throw in practice.
  // If that changes, this should be moved inside the try block to prevent blocking executeWorkflow.
  const { quiet, verbose } = options;
  const unsubscribe = getWorkflowEventEmitter().subscribeForConversation(conversationId, event => {
    if (event.type === 'workflow_started' && ownedRunId === undefined) {
      ownedRunId = event.runId;
    }
    if (!quiet) {
      renderWorkflowEvent(event, verbose ?? false);
    }
  });

  // Notify Web UI that a workflow is dispatching.
  // Mirrors the orchestrator dispatch message structure (category/segment/workflowDispatch),
  // but omits the rocket emoji and "(background)" qualifier since the CLI runs synchronously.
  // In the CLI path there is no separate worker conversation — the CLI itself
  // is both the dispatcher and the executor, so workerConversationId === conversationId.
  try {
    await adapter.sendMessage(conversationId, `Dispatching workflow: **${workflow.name}**`, {
      category: 'workflow_dispatch_status',
      segment: 'new',
      workflowDispatch: { workerConversationId: conversationId, workflowName: workflow.name },
    });
  } catch (dispatchError) {
    getLog().warn(
      { err: dispatchError as Error, conversationId },
      'cli.workflow_dispatch_surface_failed'
    );
  }

  // When --resume, hand the already-found run (and its completed-node outputs)
  // to executeWorkflow. Otherwise this is a fresh run and prepared stays null.
  // The lookup-by-(workflowName, cwd) was already done above for worktree-path
  // resolution; reuse that result rather than querying twice.
  const deps = createWorkflowDeps();
  let prepared: Awaited<ReturnType<typeof hydrateResumableRun>> = null;
  if (options.resume && resumable) {
    try {
      prepared = await hydrateResumableRun(deps, resumable);
    } catch (error) {
      const err = error as Error;
      getLog().error(
        { err, workflowName, runId: resumable.id },
        'cli.workflow_hydrate_resume_failed'
      );
      throw new Error(
        `Cannot resume workflow '${workflowName}': failed to load prior run state — ${err.message}`
      );
    }
    if (!prepared) {
      throw new Error(
        `Cannot resume: the prior run for '${workflowName}' has no completed nodes and no interactive-loop state.`
      );
    }
  }

  // Execute workflow with workingCwd (may be worktree path). `undefined` until
  // assigned so the finally-block teardown can tell "threw before a result" from
  // a real terminal/paused result.
  let result: Awaited<ReturnType<typeof executeWorkflow>> | undefined;
  // A genuine container-teardown failure captured in the finally, rethrown AFTER
  // the finally when the run itself succeeded — so a leaked privileged container
  // fails the CLI instead of reporting success + exit 0.
  let containerTeardownError: Error | undefined;
  // Container run context for the engine (Phase C): the write-back backend port +
  // env id + policy. The executor drives suspend-on-pause and the write-back gate
  // through this. Absent for host/in-place runs.
  const containerRunCtx =
    containerBackend && containerEnvId
      ? {
          envId: containerEnvId,
          writeBack: workflow.container?.write_back ?? ('approve' as const),
          backend: containerBackend,
          ...(containerOverlayMode ? { overlayMode: containerOverlayMode } : {}),
        }
      : undefined;
  // Per-child isolation resolver (#2121 slice 2, PR-A): built for git-repo codebases
  // only — a folder project can't make worktrees, so a `workflow:` node requesting
  // `isolation: 'worktree'` there fails fast in the engine (no resolver injected).
  const resolveChildIsolation =
    codebase && codebase.kind !== 'folder'
      ? createChildWorktreeResolver({
          codebaseId: codebase.id,
          codebaseName: codebase.name,
          canonicalRepoPath: codebase.default_cwd,
          baseBranch: codebaseDefaultBranch,
          createdByPlatform: 'cli',
          createdByUserId: cliUserId,
        })
      : undefined;
  try {
    const opts = prepared
      ? {
          codebaseId: codebase?.id,
          source: workflowSource,
          parseWarnings: workflowEntry?.parseWarnings,
          userId: cliUserId,
          baseBranch: codebaseDefaultBranch,
          baseOverride: flagBase,
          execContext,
          container: containerRunCtx,
          resolveChildIsolation,
          ...prepared,
        }
      : {
          codebaseId: codebase?.id,
          source: workflowSource,
          parseWarnings: workflowEntry?.parseWarnings,
          userId: cliUserId,
          baseBranch: codebaseDefaultBranch,
          baseOverride: flagBase,
          execContext,
          container: containerRunCtx,
          resolveChildIsolation,
          // Fresh run only: a resume (`prepared`) replays the inputs already on its row.
          inputs: resolvedInputs,
          ...(modelOverrides
            ? { modelOverrideLayer: { kind: 'raw' as const, overrides: modelOverrides } }
            : {}),
          ...(runConfig ? { runConfig } : {}),
          // The frozen source this run executes, captured before the workflow was even
          // selected. A resume ignores it and loads the source recorded on its own row.
          preparedSource,
          // The wrap owns the capture until `executeWorkflow`'s rename succeeds; the
          // executor adopts for us there (see #2690). Until then a rename failure
          // leaves the staged directory un-adopted so the wrap reclaims it on the
          // way out.
          capturedSourceOwner: owner,
          // Between-run continuation (#2747): written once onto the fresh row.
          ...(adoptedFromRunId !== undefined ? { adoptedFromRunId, continuationMode } : {}),
          // The row a detached parent already wrote (#2872). `inputs` and the
          // continuation fields above are still passed: the executor consumes them only
          // when IT creates the row, and this row already carries them.
          ...(detachedPreCreatedRun ? { preCreatedRun: detachedPreCreatedRun } : {}),
        };
    result = await executeWorkflow(
      deps,
      adapter,
      conversationId,
      workingCwd,
      workflow,
      userMessage,
      conversation.id,
      opts
    );
  } finally {
    await detachedRunControl?.close();
    unsubscribe();

    // Deregister the signal handlers now that the run's lifecycle is settled
    // (paused / completed / failed, or the throw propagating out of this
    // finally). A signal from here on gets default handling — the destructive
    // failWorkflowRun cleanup must never fire against a settled run (#1123),
    // and removal keeps repeated workflowRunCommand calls in one process from
    // stacking handlers.
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);

    // Container teardown (Phase C) — in `finally` so a throw from executeWorkflow
    // BEFORE its own try/catch (malformed config, env resolvers, unknown provider)
    // can't orphan a privileged container+volume. A PAUSED run keeps its (already
    // suspended, by the engine) container + volume for resume — destroying it would
    // discard the overlay the resume needs. Every OTHER outcome (completed / failed /
    // cancelled, or a pre-result throw) is terminal for this process → destroy. The
    // write-back apply already ran inside the engine before completion, so a
    // completed run's live-root changes are safe before this teardown removes the
    // volume.
    const runPaused = Boolean(result?.success && 'paused' in result && result.paused);
    // H2 — preserve the container+volume whenever the un-applied overlay is still the
    // only copy of the run's changes: a PAUSED run (awaiting the decision) OR a
    // TERMINAL run whose write-back never resolved (e.g. a partial applyChanges threw
    // → run failed with pending_writeback still un-applied). Destroying then would
    // silently discard the changes despite the "reconcile manually" message. A failed
    // run stays resumable, so `archon workflow resume <id>` re-runs the apply.
    let unresolvedWriteback = false;
    if (containerBackend && containerEnvId && !runPaused && result?.workflowRunId) {
      try {
        const finalRun = await deps.store.getWorkflowRun(result.workflowRunId);
        unresolvedWriteback = hasUnresolvedWriteback(finalRun?.metadata);
      } catch (lookupErr) {
        // FAIL CLOSED (R2-F1): if we can't read the run's metadata we can't tell
        // whether an un-applied write-back is pending — do NOT destroy (the volume
        // may be the only copy of the changes). Preserve + surface, same as an
        // unresolved write-back.
        unresolvedWriteback = true;
        getLog().error(
          { err: lookupErr as Error, envId: containerEnvId, runId: result.workflowRunId },
          'workflow.teardown_run_lookup_failed'
        );
      }
    }
    if (containerBackend && containerEnvId && unresolvedWriteback) {
      console.error(
        '\nWARNING: the write-back did not complete — the container + overlay volume are ' +
          'PRESERVED so your changes are not lost. Retry with ' +
          `\`bun run cli workflow resume ${result?.workflowRunId ?? '<run-id>'}\` (re-applies the ` +
          'overlay), or reclaim manually via `docker ps -a --filter label=diy.archon.managed=true`.'
      );
      getLog().warn(
        { envId: containerEnvId, runId: result?.workflowRunId },
        'workflow.container_preserved_unresolved_writeback'
      );
    }
    if (containerBackend && containerEnvId && !runPaused && !unresolvedWriteback) {
      try {
        await containerBackend.destroy(containerEnvId);
        // Persist a container_destroyed event (console timeline) and emit for any
        // live subscriber. The emitter fire is after unsubscribe, so the DB row is
        // the durable channel for CLI runs. No runId on the pre-result throw path —
        // skip the event, still destroy.
        const runId = result?.workflowRunId;
        if (runId) {
          getWorkflowEventEmitter().emit({
            type: 'container_lifecycle',
            runId,
            phase: 'destroyed',
          });
          await deps.store
            .createWorkflowEvent({
              workflow_run_id: runId,
              event_type: 'container_destroyed',
              step_name: 'container',
              data: {},
            })
            .catch((eventErr: Error) => {
              getLog().warn(
                { err: eventErr, runId },
                'workflow.container_destroyed_event_persist_failed'
              );
            });
        }
        console.log('Container and overlay volume removed.');
      } catch (destroyErr) {
        // destroy() throws only on a GENUINE docker failure (not idempotent
        // not-found). Surface it LOUD (console.error, not a --quiet log) so the
        // operator cleans up the privileged container manually, and CAPTURE it so
        // a successful run does not report success with a leaked container.
        console.error(
          `\nWARNING: failed to remove the isolation container/volume: ${
            (destroyErr as Error).message
          }\n` +
            'Remove it manually: docker ps -a --filter label=diy.archon.managed=true ' +
            '(then `docker rm -f <name>` and `docker volume rm <name>-upper`).'
        );
        getLog().error(
          { err: destroyErr as Error, envId: containerEnvId },
          'workflow.container_destroy_failed'
        );
        containerTeardownError = destroyErr as Error;
      }
    }
  }

  // A container teardown failure on an otherwise-SUCCESSFUL run must fail the CLI
  // (non-zero exit) — a leaked privileged container is not a success. On a failed
  // run the workflow-failed error below already exits non-zero (the leak was
  // logged loudly above), so don't mask it.
  if (containerTeardownError && result?.success) {
    throw containerTeardownError;
  }

  if (!result) {
    // executeWorkflow threw and it was re-thrown out of the try; this line is
    // unreachable in practice (the throw propagates), but it satisfies the
    // narrowing for the terminal-result checks below.
    throw new Error('Workflow did not produce a result.');
  }

  // Check result and exit appropriately
  if (result.success && 'paused' in result && result.paused) {
    console.log('\nWorkflow paused — waiting for approval.');
  } else if (result.success) {
    // Surface workflow result to Web UI as a result card (mirrors orchestrator.ts result message).
    // Paused workflows are handled in the branch above and intentionally do not get a result card.
    if ('summary' in result && result.summary) {
      try {
        await adapter.sendMessage(conversationId, result.summary, {
          category: 'workflow_result',
          segment: 'new',
          workflowResult: { workflowName: workflow.name, runId: result.workflowRunId },
        });
      } catch (surfaceError) {
        getLog().warn(
          { err: surfaceError as Error, conversationId },
          'cli.workflow_result_surface_failed'
        );
      }
    }
    console.log('\nWorkflow completed successfully.');
  } else {
    throw new WorkflowRunFailedError(result.error, detachedProcessOwner);
  }
}

/**
 * Run a specific workflow.
 *
 * A thin owner around the implementation: whatever the run does with its captured source,
 * the capture is either adopted by a run or reclaimed. The implementation has a dozen
 * ordinary ways out — unknown workflow, refused inputs, flag conflicts, a detached
 * dispatch — and asking each to remember a disposal call is how most of them did not.
 */
export async function workflowRunCommand(
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {}
): Promise<void> {
  try {
    await withCapturedSource(owner =>
      runWorkflowWithOwnedSource(owner, cwd, workflowName, userMessage, options)
    );
  } catch (error) {
    await recordDetachedChildStartupFailure(options.detachedRunId, error as Error);
    throw error;
  }
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
async function recordDetachedChildStartupFailure(
  detachedRunId: string | undefined,
  error: Error
): Promise<void> {
  if (detachedRunId === undefined) return;
  try {
    const status = await workflowDb.getWorkflowRunStatus(detachedRunId);
    if (status !== 'pending') return;
    await workflowDb.failWorkflowRun(
      detachedRunId,
      `Detached run failed to start: ${error.message}`
    );
  } catch (dbError) {
    getLog().error(
      { err: dbError as Error, workflowRunId: detachedRunId },
      'cli.detached_startup_failure_record_failed'
    );
  }
}

/**
 * Format age of a run from started_at to now.
 */
function formatAge(startedAt: Date | string): string {
  // SQLite returns UTC strings without Z suffix — append it so Date parses as UTC
  const date =
    startedAt instanceof Date
      ? startedAt
      : new Date(startedAt.endsWith('Z') ? startedAt : startedAt + 'Z');
  if (Number.isNaN(date.getTime())) return 'unknown';
  const ms = Date.now() - date.getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Format a duration in milliseconds as a compact string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m${remSecs}s`;
}

export interface NodeSummary {
  nodeId: string;
  state: 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  durationMs?: number;
  outputPreview?: string;
  error?: string;
}

/**
 * Bounded preview of a node's persisted output, shared by the two events that
 * report a success so both render the same cap.
 */
function outputPreviewOf(rawOutput: unknown): string | undefined {
  if (typeof rawOutput !== 'string') return undefined;
  return rawOutput.slice(0, 200) + (rawOutput.length > 200 ? '...' : '');
}

/**
 * Derive per-node summaries from a run's workflow events.
 * Processes node_started / node_completed / node_failed / node_skipped /
 * node_skipped_prior_success events — the last two mean opposite things and are
 * handled separately.
 */
export function buildNodeSummaries(events: WorkflowEventRow[]): NodeSummary[] {
  const startTimes = new Map<string, number>();
  const summaries = new Map<string, NodeSummary>();

  for (const event of events) {
    const nodeId = event.step_name;
    if (!nodeId) continue;

    switch (event.event_type) {
      case 'node_started': {
        startTimes.set(nodeId, new Date(event.created_at).getTime());
        // A retry is a new active attempt, so stale terminal details must not
        // leak into the compact current-state summary.
        summaries.set(nodeId, { nodeId, state: 'running', startedAt: event.created_at });
        break;
      }
      case 'node_completed': {
        const started = startTimes.get(nodeId);
        const endTime = new Date(event.created_at).getTime();
        summaries.set(nodeId, {
          nodeId,
          state: 'completed',
          startedAt: summaries.get(nodeId)?.startedAt,
          durationMs: started !== undefined ? endTime - started : undefined,
          outputPreview: outputPreviewOf(event.data.node_output),
        });
        break;
      }
      case 'node_failed': {
        const started = startTimes.get(nodeId);
        const endTime = new Date(event.created_at).getTime();
        summaries.set(nodeId, {
          nodeId,
          state: 'failed',
          startedAt: summaries.get(nodeId)?.startedAt,
          durationMs: started !== undefined ? endTime - started : undefined,
          error: typeof event.data.error === 'string' ? event.data.error : 'Unknown error',
        });
        break;
      }
      case 'node_skipped': {
        summaries.set(nodeId, { nodeId, state: 'skipped' });
        break;
      }
      case 'node_skipped_prior_success': {
        // The opposite of node_skipped: the node ran and succeeded on an earlier
        // pass, and this resume declined to re-run it. The engine re-emits one per
        // resume pass — including its own durable-wait continuation — so folding
        // these into `skipped` reported completed work as never run, and the last
        // write erased the original duration and output (#2973). The earlier
        // node_completed summary is the truth about the run, so never overwrite it.
        if (summaries.has(nodeId)) break;
        // No summary means the original node_completed is not in this log. The
        // replay still carries the prior output, so report the success it
        // describes; there is no start time to derive a duration from.
        summaries.set(nodeId, {
          nodeId,
          state: 'completed',
          outputPreview: outputPreviewOf(event.data.node_output),
        });
        break;
      }
    }
  }

  return [...summaries.values()];
}

/**
 * Fetch a run's events for `--verbose` rendering. A failed event query must not
 * abort the command (the run summary itself is still useful), but it must NOT be
 * indistinguishable from "this run has no events" — so log a warn and flag the
 * failure to the caller, which prints a visible note. (In `--json` mode logs are
 * silenced; an empty derived/raw payload is the documented signal there.)
 */
async function fetchVerboseEvents(
  runId: string
): Promise<{ events: WorkflowEventRow[]; failed: boolean }> {
  try {
    return { events: await workflowEventsDb.listWorkflowEvents(runId), failed: false };
  } catch (error) {
    getLog().warn({ err: error as Error, runId }, 'cli.workflow_events_fetch_failed');
    return { events: [], failed: true };
  }
}

/**
 * Render per-node summaries for a run's events as an indented "Nodes:" block.
 * Shared by `workflow status --verbose` and `workflow get --verbose`.
 * Prints nothing when the run has no node events.
 */
function printVerboseNodes(events: WorkflowEventRow[]): void {
  const nodes = buildNodeSummaries(events);
  if (nodes.length === 0) return;
  console.log('  Nodes:');
  for (const node of nodes) {
    const iconMap: Record<string, string> = {
      completed: '✓',
      failed: '✗',
      skipped: '-',
      running: '◌',
    };
    const icon = iconMap[node.state] ?? '◌';
    const duration = node.durationMs !== undefined ? ` (${formatDuration(node.durationMs)})` : '';
    const stateLabel = node.state === 'running' ? ' (running)' : '';
    console.log(`    ${icon} ${node.nodeId}${duration}${stateLabel}`);
    if (node.outputPreview !== undefined) {
      console.log(`        Output: ${node.outputPreview}`);
    }
    if (node.error !== undefined) {
      console.log(`        Error:  ${node.error}`);
    }
  }
}

/**
 * Show status of all running workflow runs.
 */
export async function workflowStatusCommand(
  json?: boolean,
  verbose?: boolean,
  rawEvents?: boolean
): Promise<void> {
  let runs: WorkflowRun[];
  try {
    const result = await getWorkflowStatus();
    runs = result.runs;
  } catch (error) {
    const err = error as Error;
    getLog().error({ err }, 'cli.workflow_status_failed');
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }

  if (json) {
    if (!verbose) {
      await writeJsonLine({ runs });
      return;
    }

    const fetchedPerRun = await Promise.all(runs.map(run => fetchVerboseEvents(run.id)));
    const runsOutput = runs.map((run, i) => {
      const runEvents = fetchedPerRun[i]?.events ?? [];
      return rawEvents
        ? { ...run, events: runEvents }
        : { ...run, nodes: buildNodeSummaries(runEvents) };
    });
    await writeJsonLine({ runs: runsOutput });
    return;
  }

  if (runs.length === 0) {
    console.log('No active workflows.');
    return;
  }

  console.log(`\nActive workflows (${runs.length}):\n`);
  for (const run of runs) {
    const age = formatAge(run.started_at);
    console.log(`  ID:     ${run.id}`);
    console.log(`  Name:   ${run.workflow_name}`);
    console.log(`  Path:   ${run.working_path ?? '(none)'}`);
    console.log(`  Status: ${run.status}`);
    console.log(`  Age:    ${age}`);

    if (verbose) {
      const { events, failed } = await fetchVerboseEvents(run.id);
      if (failed) {
        console.log('  (node events unavailable — see logs)');
      }
      printVerboseNodes(events);
    }

    console.log('');
  }
}

/**
 * One human-readable line naming the run and what it needs.
 *
 * `awaiting_response` deliberately names TWO runs when they differ: a parent blocked on
 * a sub-run wakes on the child's gate, and the address in the value is the whole
 * reason the caller can act on it.
 */
function formatWaitOutcome(watchedRunId: string, result: RunWaitResult): string {
  switch (result.kind) {
    case 'deadline':
      return `Timed out waiting on run ${watchedRunId} — still ${result.observedStatus}.`;
    case 'aborted':
      return `Stopped waiting on run ${watchedRunId}.`;
    case 'not_found':
      return `Workflow run not found: ${watchedRunId}`;
    case 'attention':
      break;
  }
  const attention = result.attention;
  switch (attention.kind) {
    case 'terminal':
      return `Run ${watchedRunId} ${attention.status}.`;
    case 'awaiting_response':
      return attention.respondTo.runId === watchedRunId
        ? `Run ${watchedRunId} is waiting for a response at gate '${attention.respondTo.nodeId}'.`
        : `Run ${watchedRunId} is blocked on sub-run ${attention.respondTo.runId}, which is waiting ` +
            `for a response at gate '${attention.respondTo.nodeId}'.`;
    case 'blocked_on_child':
      // Unreachable through the waiter, which resolves the chain before returning.
      return `Run ${watchedRunId} is blocked on sub-run ${attention.childRunId}.`;
    case 'unreadable':
      return `Run ${watchedRunId} needs a look: ${attention.detail}.`;
  }
}

/**
 * Say once, on stderr, that the wait is now watching the run.
 *
 * Until this line the command is completely silent, and neither a human nor a host
 * can tell an attached wait from one still resolving the id — or from one that died
 * on the way. It also fixes the instant the watch began: a transition after this line
 * reached the caller as a wake, where the same transition before it would have been
 * an ordinary read of an already-settled row.
 *
 * stderr, not stdout, because `--json` promises exactly one document on stdout. The
 * shape follows the same split as the answer itself: the JSON envelope for a machine,
 * one plain sentence for a person.
 *
 * Through `writeStderr` rather than `console.error`/`console.warn`, and awaited: this
 * line exists to tell a host when the watch began, and `console.error` to a pipe whose
 * reader has gone is a silent no-op under Bun. A line that can vanish without a trace
 * cannot carry an ordering.
 */
function announceWaitAttached(
  watchedRunId: string,
  observedStatus: WorkflowRunStatus,
  json?: boolean
): Promise<void> {
  const line = json
    ? JSON.stringify({
        ok: true,
        action: 'wait',
        runId: watchedRunId,
        result: 'waiting',
        observedStatus,
      })
    : `Waiting on run ${watchedRunId} — currently ${observedStatus}.`;
  return writeStderr(`${line}\n`);
}

/**
 * Block until a run finishes or parks on a gate awaiting a response, then say which.
 *
 * The point of the verb: a host that launched a run with `--detach` waits on one
 * command instead of polling `workflow get`. Exit codes describe the COMMAND, not the
 * run — 0 the run said something, 3 the deadline passed with the run still live, 1 the
 * wait itself failed. A `failed` or `cancelled` run is still exit 0 with its status on
 * stdout; mapping run state onto the process exit code would make a legitimately
 * cancelled run look like a broken command.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowWaitCommand(
  runId: string,
  json?: boolean,
  cwd?: string,
  timeoutSeconds?: number
): Promise<number> {
  let result: RunWaitResult;
  let resolvedId: string;
  try {
    resolvedId = await resolveRunIdArg(runId, cwd);
    result = await waitForRunAttention(resolvedId, {
      // No timeout by default: a wait that ends on its own clock would answer a
      // question only the run can answer.
      ...(timeoutSeconds === undefined ? {} : { deadlineMs: timeoutSeconds * 1000 }),
      onAttached: observedStatus => announceWaitAttached(resolvedId, observedStatus, json),
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_wait_failed');
    // In --json mode never throw — emit one parseable {ok:false} line (same contract
    // as `get` and the write commands) so a parsing agent always gets JSON.
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: err.message });
      return 1;
    }
    throw new Error(`Failed to wait for workflow run: ${err.message}`);
  }

  if (result.kind === 'not_found') {
    if (json) {
      await writeJsonLine({ ok: false, runId, action: 'wait', error: 'not_found' });
    } else {
      console.log(formatWaitOutcome(resolvedId, result));
    }
    return 1;
  }

  if (json) {
    await writeJsonLine({
      ok: true,
      action: 'wait',
      runId: resolvedId,
      result: result.kind,
      ...(result.kind === 'attention' ? { attention: result.attention } : {}),
      ...(result.kind === 'deadline' ? { observedStatus: result.observedStatus } : {}),
    });
  } else {
    console.log(formatWaitOutcome(resolvedId, result));
  }

  // 3 keeps "the run is still live" distinguishable from both a real answer (0) and a
  // broken wait (1).
  return result.kind === 'deadline' ? 3 : 0;
}

/**
 * Show detail for a single workflow run by ID (any status).
 *
 * Unlike `status` (active runs only), this resolves one run regardless of
 * status — so an agent can answer "did the review pass?" for a completed/failed
 * run. `--verbose` adds the per-node summary; `--json` emits the raw run plus a
 * `nodes` array when verbose (`--events` selects raw event rows instead).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowGetCommand(
  runId: string,
  json?: boolean,
  verbose?: boolean,
  cwd?: string,
  rawEvents?: boolean
): Promise<number> {
  let run: WorkflowRun | null;
  try {
    const resolvedId = await resolveRunIdArg(runId, cwd);
    run = await workflowDb.getWorkflowRun(resolvedId);
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, runId }, 'cli.workflow_get_failed');
    // In --json mode never throw — emit one parseable {ok:false} line (same
    // contract as the write commands) so a parsing agent always gets JSON.
    if (json) {
      await writeJsonLine({ ok: false, runId, error: err.message });
      return 1;
    }
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }

  if (!run) {
    // Not-found exits non-zero so `get <id> && ...` and CI checks see the
    // failure (the JSON envelope already carries ok:false for parsers).
    if (json) {
      await writeJsonLine({ ok: false, runId, error: 'not_found' });
    } else {
      console.log(`Workflow run not found: ${runId}`);
    }
    return 1;
  }

  // getWorkflowRun returns the base WorkflowRun (no current_step_name) — derive
  // per-node detail from the event log, and only when verbose is requested.
  let events: WorkflowEventRow[] | undefined;
  let eventsFailed = false;
  if (verbose) {
    const fetched = await fetchVerboseEvents(run.id);
    events = fetched.events;
    eventsFailed = fetched.failed;
  }

  // Leave-behind view (#2747): what did this run leave, and where. Assembled
  // from existing data — status/outcome, adoption chain, and its artifact file
  // list resolved through the persisted output_root (read-only by contract).
  let leaveBehind: LeaveBehind | undefined;
  try {
    leaveBehind = await buildLeaveBehind(run);
  } catch (error) {
    getLog().warn({ err: error as Error, runId: run.id }, 'cli.workflow_get_leave_behind_failed');
  }

  if (json) {
    if (!verbose) {
      await writeJsonLine({ ...run, ...(leaveBehind ? { leave_behind: leaveBehind } : {}) });
      return 0;
    }

    const verboseEvents = events ?? [];
    const parseWarnings = readParseWarningEvents(verboseEvents);
    const output = rawEvents
      ? { ...run, events: verboseEvents }
      : {
          ...run,
          nodes: buildNodeSummaries(verboseEvents),
          // Keys the engine dropped from this run's YAML (#2213). Surfaced as a
          // named field rather than leaving the caller to scan raw events.
          ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
        };
    await writeJsonLine(output);
    return 0;
  }

  console.log(`  ID:     ${run.id}`);
  console.log(`  Name:   ${run.workflow_name}`);
  console.log(`  Path:   ${run.working_path ?? '(none)'}`);
  console.log(`  Status: ${run.status}${run.outcome ? ` (${run.outcome})` : ''}`);
  console.log(`  Age:    ${formatAge(run.started_at)}`);
  // Paused interactive-loop gate: one honest line so a human (or an agent parsing
  // the plain output) sees whether any declared completion condition completed
  // the paused iteration (#2074). --json already carries the full metadata.approval.
  const gateMeta = run.metadata.approval;
  if (
    run.status === 'paused' &&
    isApprovalContext(gateMeta) &&
    gateMeta.type === 'interactive_loop'
  ) {
    const completionMet = gateMeta.completionSignaled === true ? 'yes' : 'no';
    console.log(
      `  Gate:   awaiting approval — completion condition met: ${completionMet} (iteration ${String(gateMeta.iteration ?? '?')})`
    );
  }
  const waitMeta = run.metadata.wait;
  if (run.status === 'paused' && isWorkflowWaitContext(waitMeta)) {
    console.log(
      waitMeta.kind === 'event'
        ? `  Wait:   event '${waitMeta.event ?? '?'}' until ${waitMeta.resumeAt}`
        : `  Wait:   until ${waitMeta.resumeAt}`
    );
  }
  const scheduledResume = run.metadata.scheduled_resume;
  if (
    run.status === 'failed' &&
    isScheduledWorkflowResume(scheduledResume) &&
    scheduledResume.triggeredAt === undefined
  ) {
    console.log(
      `  Resume: scheduled for ${scheduledResume.resumeAt} (attempt ${String(scheduledResume.attempt)}/${String(scheduledResume.maxAttempts)})`
    );
  }
  const runError = typeof run.metadata.error === 'string' ? run.metadata.error : undefined;
  if (runError) {
    console.log(`  Error:  ${runError}`);
  }
  if (leaveBehind) {
    console.log('  Leave-behind:');
    if (leaveBehind.branch) console.log(`    Branch: ${leaveBehind.branch}`);
    if (leaveBehind.worktree) {
      console.log(
        `    Worktree: ${leaveBehind.worktree} (${leaveBehind.worktreeLive ? 'live' : 'gone'})`
      );
    }
    if (leaveBehind.adopted_from) console.log(`    Adopted from: ${leaveBehind.adopted_from}`);
    for (const a of leaveBehind.adopted_by) console.log(`    Adopted by: ${a}`);
    if (leaveBehind.artifactFiles.length > 0) {
      console.log(
        `    Artifacts (${String(leaveBehind.artifactFiles.length)} files under $ARTIFACTS_DIR):`
      );
      for (const f of leaveBehind.artifactFiles.slice(0, 20)) console.log(`      - ${f}`);
      if (leaveBehind.artifactFiles.length > 20) console.log('      …');
    }
  }
  if (events) {
    if (eventsFailed) {
      console.log('  (node events unavailable — see logs)');
    }
    const parseWarnings = readParseWarningEvents(events);
    if (parseWarnings.length > 0) {
      console.log(`  Ignored keys (${String(parseWarnings.length)}):`);
      for (const w of parseWarnings) console.log(`    - ${w}`);
    }
    printVerboseNodes(events);
  }
  return 0;
}

/**
 * Pull the dropped-key warnings out of a run's event log (#2213).
 *
 * The engine records them once at run start as `workflow_parse_warnings`,
 * whatever surface started the run — so this is the read path for a run that
 * had no conversation to post into (CLI, REST) or whose chat delivery failed.
 */
/**
 * Leave-behind view (#2747): what a run concluded and what it left undone —
 * outcome, branch, worktree (live or gone), adoption chain, and its artifact
 * file list. Artifacts resolve through the persisted `output_root` and are
 * read-only here: the adopting run references them via `$ADOPTED_RUN_DIR`, it
 * never writes into them.
 */
interface LeaveBehind {
  branch?: string;
  worktree?: string;
  worktreeLive?: boolean;
  adopted_from?: string;
  adopted_by: string[];
  artifactFiles: string[];
}

async function buildLeaveBehind(run: WorkflowRun): Promise<LeaveBehind> {
  const leaveBehind: LeaveBehind = { adopted_by: [], artifactFiles: [] };

  if (run.working_path) {
    leaveBehind.worktree = run.working_path;
    leaveBehind.worktreeLive = existsSync(run.working_path);
  }
  if (run.adopted_from_run_id) leaveBehind.adopted_from = run.adopted_from_run_id;
  leaveBehind.adopted_by = (await workflowDb.findAdoptingRuns(run.id)).map(r => r.id);

  // Branch from the isolation record that owned the working path, if any.
  if (run.codebase_id && run.working_path) {
    try {
      const envs = await isolationDb.listByCodebase(run.codebase_id);
      const env = envs.find(e => e.working_path === run.working_path);
      if (env) leaveBehind.branch = env.branch_name;
    } catch (error) {
      getLog().debug({ err: error as Error }, 'cli.workflow_get_branch_lookup_failed');
    }
  }

  // Artifact file list — capped walk so `get` stays cheap on big runs.
  if (run.output_root) {
    try {
      const artifactsDir = archonPaths.getRunArtifactsDirForRoot(run.output_root, run.id);
      leaveBehind.artifactFiles = listArtifactFiles(artifactsDir);
    } catch (error) {
      getLog().debug({ err: error as Error }, 'cli.workflow_get_artifact_walk_failed');
    }
  }
  return leaveBehind;
}

/** Relative paths under `dir`, shallow-walked with a hard cap (#2747 display). */
function listArtifactFiles(dir: string, maxFiles = 200): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    if (out.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

function readParseWarningEvents(events: readonly WorkflowEventRow[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (event.event_type !== 'workflow_parse_warnings') continue;
    const raw: unknown = (event.data as Record<string, unknown> | null)?.warnings;
    if (Array.isArray(raw)) out.push(...raw.filter((w): w is string => typeof w === 'string'));
  }
  return out;
}

/**
 * List recent workflow runs for the current project (all statuses, cwd-scoped).
 *
 * Complements `status` (active-only): resolves the codebase from `cwd` the same
 * way `workflow run` does, then lists that project's recent runs of every
 * status. `--all` drops the project scope (lists across all projects);
 * `--status` filters to one status; `--limit` caps the count (default 20).
 */
export async function workflowRunsCommand(
  cwd: string,
  opts: { json?: boolean; all?: boolean; status?: string; limit?: number; open?: boolean } = {}
): Promise<void> {
  // Open-work inbox (#2747): terminal failed runs nothing has adopted or
  // superseded — the operator's "what ended with work on the table" query.
  // Status-derived v1 semantics; --status/--open are mutually exclusive shapes.
  if (opts.open) {
    if (opts.status) {
      const msg = '--open and --status are mutually exclusive: the inbox is failed runs only.';
      if (opts.json) {
        await writeJsonLine({ ok: false, error: msg });
        return;
      }
      throw new Error(msg);
    }
    let codebase = null;
    if (!opts.all) {
      try {
        codebase = await findCodebaseForCheckoutPath(cwd);
      } catch (error) {
        getLog().warn({ err: error as Error, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
      }
    }
    const runs = await workflowDb.findOpenWorkRuns({
      codebaseId: opts.all ? undefined : (codebase?.id ?? undefined),
      limit: opts.limit ?? 20,
    });
    if (opts.json) {
      await writeJsonLine({ runs, total: runs.length, scopeFallback: !opts.all && !codebase });
      return;
    }
    if (runs.length === 0) {
      console.log('No open workflow runs — nothing ended with work on the table.');
      return;
    }
    console.log(`\nOpen work (${String(runs.length)}):\n`);
    for (const run of runs) {
      console.log(
        `  ${run.id.slice(0, 8)}  ${run.workflow_name}  (${formatAge(run.started_at)})  adopt: workflow run <name> --adopt ${run.id}`
      );
    }
    console.log('');
    return;
  }

  let statusFilter: WorkflowRunStatus | undefined;
  if (opts.status) {
    const parsed = workflowRunStatusSchema.safeParse(opts.status);
    if (!parsed.success) {
      const msg = `Invalid --status '${opts.status}'. Valid: ${workflowRunStatusSchema.options.join(', ')}.`;
      // --json never throws — emit one parseable {ok:false} line (write-command contract).
      if (opts.json) {
        await writeJsonLine({ ok: false, error: msg });
        return;
      }
      throw new Error(msg);
    }
    statusFilter = parsed.data;
  }

  // Scope to this project by exact registration first, then through the
  // checkout's canonical repository path. This preserves an explicitly
  // registered linked worktree while allowing another linked worktree to share
  // its registered primary checkout. Ordinary clones remain unchanged (#2613).
  // --all opts out of scoping. A lookup failure or an unregistered cwd both
  // fall back to the global list — never a silent wrong-scope (the human path
  // prints an explicit note below).
  let codebase = null;
  if (!opts.all) {
    try {
      codebase = await findCodebaseForCheckoutPath(cwd);
    } catch (error) {
      getLog().warn({ err: error as Error, cwd }, 'cli.workflow_runs_codebase_lookup_failed');
    }
  }
  // listDashboardRuns ignores undefined filters (truthy-guarded WHERE clauses),
  // so pass codebaseId/status straight through — no conditional spread needed.
  const codebaseId = opts.all ? undefined : codebase?.id;

  let result;
  try {
    result = await workflowDb.listDashboardRuns({
      codebaseId,
      status: statusFilter,
      limit: opts.limit ?? 20,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, cwd }, 'cli.workflow_runs_failed');
    if (opts.json) {
      await writeJsonLine({ ok: false, error: err.message });
      return;
    }
    throw new Error(`Failed to list workflow runs: ${err.message}`);
  }

  // True when project scoping was requested but fell back to the global list
  // (unregistered cwd or a lookup failure). The human path prints a note below;
  // surface the same signal in --json so an agent isn't handed a global result
  // it silently mistakes for a project-scoped one.
  const scopeFallback = !opts.all && !codebase;

  if (opts.json) {
    await writeJsonLine({ ...result, scopeFallback });
    return;
  }

  if (scopeFallback) {
    console.log('(not a registered project — showing all runs)');
  }

  if (result.runs.length === 0) {
    console.log('No workflow runs found.');
    return;
  }

  console.log(`\nRecent runs (${result.runs.length} of ${result.total}):\n`);
  for (const run of result.runs) {
    const step =
      run.current_step_name !== null
        ? ` · ${run.current_step_name}${run.total_steps !== null ? `/${String(run.total_steps)}` : ''}`
        : '';
    console.log(
      `  ${run.id.slice(0, 8)}  ${run.status.padEnd(9)}  ${run.workflow_name}${step}  (${formatAge(run.started_at)})`
    );
  }
  console.log('');
}

/**
 * Emit the standard `{ ok: false }` error line for a `--json` write command
 * (approve/reject/abandon/resume). Centralizes the envelope so all four stay in
 * lockstep; never throws — in --json mode the JSON line IS the error surface.
 */
function printJsonWriteError(runId: string, action: string, error: unknown): Promise<void> {
  return writeJsonLine({ ok: false, runId, action, error: (error as Error).message });
}

/**
 * Matches a full run id: a dashed UUID (Postgres `gen_random_uuid()`) or 32
 * undashed hex chars (SQLite `hex(randomblob(16))`). Anything shorter is
 * treated as a prefix.
 */
const FULL_RUN_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

/**
 * Resolve a run-id argument that may be the 8-char short id printed by
 * `workflow runs` into the full run id. Mirrors the chat `manage_run` tool's
 * prefix resolution (getScopedRun): the lookup is scoped to the cwd's
 * codebase, a unique match resolves, and an ambiguous prefix errors.
 *
 * Full UUIDs skip resolution entirely — exact lookup is global, so full ids
 * keep working from any directory. A caller that already resolved a project can
 * provide its id; otherwise project lookup preserves an exact checkout
 * registration, then falls back to a linked worktree's canonical checkout. By
 * default, an omitted or unregistered cwd and an unmatched prefix pass through
 * unchanged so the downstream exact lookup keeps its existing error surface.
 * Callers without a downstream lookup can require a match instead.
 */
async function resolveRunIdArg(
  runId: string,
  cwd?: string,
  requirePrefixMatch = false,
  codebaseId?: string
): Promise<string> {
  if (FULL_RUN_ID_RE.test(runId)) return runId;
  if (cwd === undefined && codebaseId === undefined) {
    if (requirePrefixMatch) {
      throw new Error(`Cannot resolve run id prefix '${runId}' without a project directory.`);
    }
    return runId;
  }
  const resolvedCodebaseId =
    codebaseId ?? (cwd === undefined ? undefined : (await findCodebaseForCheckoutPath(cwd))?.id);
  if (!resolvedCodebaseId) {
    if (requirePrefixMatch) {
      throw new Error(`Cannot resolve run id prefix '${runId}' outside a registered project.`);
    }
    return runId;
  }
  const matches = await workflowDb.findWorkflowRunsByIdPrefix(runId, resolvedCodebaseId);
  if (matches.length > 1) {
    const candidates = matches.map(match => `  ${match.id}`).join('\n');
    throw new Error(
      `Run id '${runId}' matches more than one run in this project:\n${candidates}\nUse more characters or the full id.`
    );
  }
  if (matches.length === 0) {
    if (requirePrefixMatch) {
      throw new Error(`No workflow run matches prefix '${runId}' in this project.`);
    }
    return runId;
  }
  return matches[0].id;
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
 * command from process.argv AND awaits the startup window (#2279) — so a child that
 * dies immediately throws here rather than being acked as started. That await is load
 * bearing: dropping it turns every startup failure into an unhandled rejection arriving
 * after the parent has already printed `{ ok: true }`.
 */
async function runDetachedControlCommand(
  runId: string,
  action: 'approve' | 'reject' | 'respond' | 'resume',
  json: boolean | undefined,
  cwd: string | undefined,
  precheck: () => Promise<WorkflowRun>
): Promise<void> {
  try {
    const run = await precheck();
    // The caller's --cwd, already resolved by cli.ts — NOT process.cwd(). The
    // appended --cwd is last-wins on the child's argv, so discarding it here
    // strands the child in the parent's directory (possibly outside any git
    // repo) after the parent has already acked success. The run's working_path
    // is still never a candidate: a container run's working_path is a distro
    // path the host cannot spawn into, so the child re-resolves by run id.
    const logPath = await spawnDetachedWorkflowRun(cwd ?? process.cwd(), runId, []);
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
      return;
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
      return;
    }
    throw error;
  }
}

async function resolveDiscoveryCwdForCodebase(
  runId: string,
  codebaseId: string,
  action: 'resume' | 'approve' | 'reject' | 'respond'
): Promise<string> {
  try {
    const codebase = await codebaseDb.getCodebase(codebaseId);
    if (!codebase) {
      throw new Error(
        `Workflow run '${runId}' references codebase '${codebaseId}', but that codebase no longer exists.\n` +
          'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
          'Re-register the project or restore the codebase row, then retry.'
      );
    }
    return codebase.default_cwd;
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('references codebase')) {
      throw err;
    }
    getLog().error(
      { err, errorType: err.constructor.name, runId, codebaseId },
      `cli.workflow_${action}_codebase_lookup_failed`
    );
    throw new Error(
      `Failed to load codebase '${codebaseId}' for workflow run '${runId}': ${err.message}\n` +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Fix the codebase lookup problem, then retry.'
    );
  }
}

/**
 * Resume a failed workflow run by ID.
 *
 * Re-executes the workflow with --resume semantics: `workflowRunCommand` locates
 * the prior failed run via findResumableRun and hands it to the executor, which
 * skips already-completed nodes (the executor no longer auto-detects on its own).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowResumeCommand(
  runId: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<void> {
  // --detach: validate read-only (resumeWorkflowOp checks the run is resumable),
  // then let a detached child re-invoke the blocking resume and own all mutation
  // + execution, so a reaped launching shell can't wedge the run mid-resume.
  // Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(runId, cwd);
    await runDetachedControlCommand(resolvedId, 'resume', json, cwd, async () => {
      const run = await resumeWorkflowOp(resolvedId);
      // The inline path below refuses a run with no recorded working path. Check it
      // here too, on the run the precheck already holds (message copied verbatim):
      // otherwise the parent acks success and the child throws where nobody reads it.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume. The run may be too old.'
        );
      }
      return run;
    });
    return;
  }

  // JSON mode is a non-blocking control-plane ack: validate the run is resumable
  // and report its state, but do NOT re-execute the workflow inline (execution
  // streams workflow output to stdout, which would corrupt the JSON contract).
  // To actually execute a resumable run, use the blocking `resume` (no --json,
  // run as a background task) or `resume <run-id> --detach`. Prefer that exact-id
  // form over `run <name> --resume --detach`, which selects the newest resumable
  // run of that workflow in the CURRENT checkout — a different question, and the
  // wrong one when the caller already holds a run id (#2645).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const run = await resumeWorkflowOp(resolvedId);
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'resume',
        executed: false,
        status: run.status,
        workflowName: run.workflow_name,
        workingPath: run.working_path,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'resume', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const run = await resumeWorkflowOp(resolvedId);
  if (!run.working_path) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume. The run may be too old.'
    );
  }
  console.log(`Resuming workflow: ${run.workflow_name}`);
  console.log(`Path: ${run.working_path}`);
  console.log('');

  // Use the codebase's source path for workflow YAML discovery so the file is
  // found even when working_path is a worktree or workspace clone that does
  // not contain the user's local (often untracked) workflow YAML.
  const discoveryCwd = run.codebase_id
    ? await resolveDiscoveryCwdForCodebase(resolvedId, run.codebase_id, 'resume')
    : undefined;

  // Re-execute via workflowRunCommand with --resume: it locates the prior failed
  // run via findResumableRun and skips already-completed nodes (the executor
  // itself no longer auto-detects resumable runs).
  try {
    await workflowRunCommand(run.working_path, run.workflow_name, run.user_message ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: run,
      resume: true,
      codebaseId: run.codebase_id ?? undefined,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: run.workflow_name },
      'cli.workflow_resume_run_failed'
    );
    throw new Error(`Failed to resume workflow '${run.workflow_name}': ${err.message}`, {
      cause: err,
    });
  }
}

/**
 * Abandon a workflow run by ID (marks it as cancelled).
 *
 * `--json` emits a structured result instead of human text. In JSON mode the
 * command never throws — lookup/state errors are reported as `{ ok: false }` so
 * a parsing agent always gets one clean JSON line.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowAbandonCommand(
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<void> {
  // The container reclaim (M2) now lives in the shared `abandonWorkflow` op, so EVERY
  // surface reclaims — the CLI just reports the cancellation. Keeps `--json` a clean
  // one-line contract (no reclaim text before the payload).
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const { run, cascadeFailures, blockedParentRunId } = await abandonWorkflow(resolvedId);
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'abandon',
        status: 'cancelled',
        workflowName: run.workflow_name,
        ...(cascadeFailures > 0 ? { cascadeFailures } : {}),
        ...(blockedParentRunId ? { blockedParentRunId } : {}),
      });
    } catch (error) {
      await printJsonWriteError(runId, 'abandon', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const { run, cascadeFailures, blockedParentRunId } = await abandonWorkflow(resolvedId);
  console.log(`Abandoned workflow run: ${resolvedId}`);
  console.log(`Workflow: ${run.workflow_name}`);
  printRunTreeCancellationWarnings(cascadeFailures, blockedParentRunId);
}

function printRunTreeCancellationWarnings(
  cascadeFailures: number,
  blockedParentRunId: string | null
): void {
  if (cascadeFailures > 0) {
    console.log(
      `Warning: ${String(cascadeFailures)} sub-run(s) could not be cancelled and may still be running — check \`archon workflow status\`.`
    );
  }
  if (blockedParentRunId) {
    console.log(
      `Warning: parent run ${blockedParentRunId} was blocked on this sub-run and stays paused.`
    );
    console.log(
      `  Resume it to fail the node cleanly (archon workflow resume ${blockedParentRunId}) or abandon it too.`
    );
  }
}

/**
 * Actively cancel a run owned by a detached CLI child.
 *
 * Ordering is the contract: prove the live exact-run owner, terminate its process
 * tree, then record `cancelled`. An unreachable owner never falls back to a DB-only
 * transition — operators use `abandon` separately after verifying an orphan.
 */
export async function workflowCancelCommand(
  runId: string,
  json?: boolean,
  cwd?: string
): Promise<void> {
  const cancel = async (): Promise<{
    resolvedId: string;
    workflowName: string;
    cascadeFailures: number;
    blockedParentRunId: string | null;
  }> => {
    const resolvedId = await resolveRunIdArg(runId, cwd);
    const current = await workflowDb.getWorkflowRun(resolvedId);
    if (!current) throw new Error(`Workflow run not found: ${resolvedId}`);
    if (current.status !== 'running') {
      throw new Error(
        `Cannot actively cancel run with status '${current.status}'. Only a running detached CLI run has live work to stop.`
      );
    }

    let containerEnvId: string | undefined;
    if (current.metadata?.isolation === 'container') {
      const isolationEnvId = current.metadata.isolation_env_id;
      if (typeof isolationEnvId !== 'string' || isolationEnvId.trim().length === 0) {
        throw new Error(
          `Cannot confirm the isolation container owned by run ${resolvedId}. ` +
            'The run was not changed; its container tracking ID is missing.'
        );
      }
      containerEnvId = isolationEnvId;
      const containerEnv = await isolationDb.getById(containerEnvId);
      if (containerEnv?.provider !== 'container') {
        throw new Error(
          `Cannot confirm the isolation container owned by run ${resolvedId}. ` +
            'The run was not changed; inspect the managed containers before retrying or abandoning it.'
        );
      }
    }

    const target = await requestDetachedRunStop(resolvedId);
    await target.stop();

    if (containerEnvId) {
      try {
        await reclaimContainerEnv(containerEnvId);
      } catch (error) {
        throw new Error(
          'Detached owner process stopped, but the isolation container could not be confirmed stopped. ' +
            `Run state was not changed. ${(error as Error).message}`
        );
      }
    }

    const { run, cancelled, cascadeFailures, blockedParentRunId } =
      await abandonWorkflow(resolvedId);
    if (!cancelled) {
      const latest = await workflowDb.getWorkflowRun(resolvedId);
      throw new Error(
        'Detached work stopped, but cancellation did not win the run state transition. ' +
          `The run status is ${latest?.status ?? 'unknown'}; it was not reported as cancelled.`
      );
    }
    return {
      resolvedId,
      workflowName: run.workflow_name,
      cascadeFailures,
      blockedParentRunId,
    };
  };

  if (json) {
    try {
      const result = await cancel();
      await writeJsonLine({
        ok: true,
        runId: result.resolvedId,
        action: 'cancel',
        status: 'cancelled',
        processStopped: true,
        workflowName: result.workflowName,
        ...(result.cascadeFailures > 0 ? { cascadeFailures: result.cascadeFailures } : {}),
        ...(result.blockedParentRunId ? { blockedParentRunId: result.blockedParentRunId } : {}),
      });
    } catch (error) {
      await printJsonWriteError(runId, 'cancel', error);
    }
    return;
  }

  const result = await cancel();
  console.log(`Cancelled detached workflow run: ${result.resolvedId}`);
  console.log(`Workflow: ${result.workflowName}`);
  console.log('Host process tree stopped before run state was changed.');
  printRunTreeCancellationWarnings(result.cascadeFailures, result.blockedParentRunId);
}

/**
 * Approve a paused workflow run by ID.
 *
 * Human mode records the approval on the still-'paused' run (the resolution
 * lives in metadata.approval.resolved, #2075) and then auto-resumes the run
 * inline. `--json` mode records the approval and returns a structured ack
 * WITHOUT resuming — the run stays paused-and-staged, resumable by a
 * backgrounded `resume`/`run --resume` (inline resume would stream output and
 * break the JSON).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowApproveCommand(
  runId: string,
  comment?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<void> {
  // --detach: hand the approve AND its inline auto-resume to a detached child
  // (same argv minus --detach/--json). Handled BEFORE any state change — the
  // parent only validates read-only, so the approval is recorded exactly once,
  // in the child. Composes with --json (structured ack; nothing executes here).
  if (detach) {
    const resolvedId = await resolveRunIdArg(runId, cwd);
    await runDetachedControlCommand(resolvedId, 'approve', json, cwd, async () => {
      const run = await workflowDb.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gate approveWorkflow enforces — not a copy of one branch of it.
      // A partial copy acks { ok: true } and lets the child die unseen.
      assertApprovable(run);
      // The child always auto-resumes after approving, and the inline path below
      // refuses a run with no recorded working path. Same check here (message
      // copied verbatim) so the refusal is synchronous instead of buried in a log.
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
    return;
  }

  // JSON mode records the approval and returns a structured ack WITHOUT the
  // inline auto-resume (resuming executes the workflow and streams output to
  // stdout, which would corrupt the JSON contract). The run becomes resumable
  // — drive it to completion with a backgrounded `resume`/`run --resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const result = await approveWorkflow(resolvedId, comment);
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'approve',
        type: result.type,
        workflowName: result.workflowName,
        resumable: true,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'approve', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const result = await approveWorkflow(resolvedId, comment);

  // CLI auto-resumes after approval, as chat does since #2565. `--json` (handled
  // above) is the one surface that records the decision without continuing.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Approved workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = await conversationDb.getConversationById(result.conversationId);
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId: resolvedId, conversationId: result.conversationId },
        'cli.workflow_approve_conversation_not_found'
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId: resolvedId, conversationId: result.conversationId },
      'cli.workflow_approve_conversation_lookup_failed'
    );
  }

  try {
    // Use the codebase's source path for workflow YAML discovery so the file is
    // found even when working_path is a worktree or workspace clone that does
    // not contain the user's local (often untracked) workflow YAML.
    const discoveryCwd = result.codebaseId
      ? await resolveDiscoveryCwdForCodebase(resolvedId, result.codebaseId, 'approve')
      : undefined;

    await workflowRunCommand(result.workingPath, result.workflowName, result.userMessage ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: (await workflowDb.getWorkflowRun(resolvedId)) ?? undefined,
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: result.workflowName },
      'cli.workflow_approve_resume_failed'
    );
    throw new Error(
      `Approved but failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The approval was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`,
      { cause: err }
    );
  }
}

/**
 * Reject a paused workflow run by ID.
 * If the workflow has an on_reject prompt, auto-resumes with the rejection feedback;
 * otherwise marks the run as cancelled.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRejectCommand(
  runId: string,
  reason?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<void> {
  // --detach: hand the reject AND its inline on_reject rework to a detached child,
  // exactly as approve does. Without it, reject hosts the executor in the calling
  // shell — a reaped shell (harness task, closed terminal) leaves the run wedged
  // mid-rework. The parent only validates read-only. Composes with --json.
  if (detach) {
    const resolvedId = await resolveRunIdArg(runId, cwd);
    await runDetachedControlCommand(resolvedId, 'reject', json, cwd, async () => {
      const run = await workflowDb.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      // The SAME gate rejectWorkflow enforces — not a copy of one branch of it.
      // A partial copy acks { ok: true } and lets the child die unseen.
      assertRejectable(run);
      return run;
    });
    return;
  }

  // An empty or omitted reason still needs a meaningful value on the new-mode
  // structured-output path (#2740) — rejectWorkflow's own internal default
  // only covers the audit event and legacy rework/cancel path.
  const rejectText = reason && reason.length > 0 ? reason : 'Rejected';

  // JSON mode records the rejection and returns a structured ack WITHOUT the
  // inline auto-resume (an on_reject rework executes the workflow and streams
  // to stdout, corrupting the JSON contract). When `cancelled` is false the run
  // is resumable for the rework pass — drive it with a backgrounded `resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const result = await rejectWorkflow(resolvedId, rejectText);
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'reject',
        cancelled: result.cancelled,
        maxAttemptsReached: result.maxAttemptsReached,
        workflowName: result.workflowName,
        resumable: !result.cancelled,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'reject', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const result = await rejectWorkflow(resolvedId, rejectText);

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    return;
  }

  // Not cancelled = a legacy on_reject rework, a #2707 step-1 new-mode
  // resolution, or a container write-back reject (discard the overlay). All
  // three auto-resume; the resume drives the rework / continuation / the
  // overlay discard + completion.
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Rejected workflow: ${result.workflowName}`);
  console.log(
    result.writeBack
      ? 'Discarding container changes (live folder left untouched)...'
      : result.newMode
        ? 'Resuming...'
        : 'Resuming with on_reject prompt...'
  );

  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = await conversationDb.getConversationById(result.conversationId);
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId: resolvedId, conversationId: result.conversationId },
        'cli.workflow_reject_conversation_not_found'
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId: resolvedId, conversationId: result.conversationId },
      'cli.workflow_reject_conversation_lookup_failed'
    );
  }

  try {
    // Use the codebase's source path for workflow YAML discovery so the file is
    // found even when working_path is a worktree or workspace clone that does
    // not contain the user's local (often untracked) workflow YAML.
    const discoveryCwd = result.codebaseId
      ? await resolveDiscoveryCwdForCodebase(resolvedId, result.codebaseId, 'reject')
      : undefined;

    await workflowRunCommand(result.workingPath, result.workflowName, result.userMessage ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: (await workflowDb.getWorkflowRun(resolvedId)) ?? undefined,
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: result.workflowName },
      'cli.workflow_reject_resume_failed'
    );
    throw new Error(
      `Rejected but failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The rejection was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`,
      { cause: err }
    );
  }
}

/**
 * Resolve a paused workflow run with any of its gate's declared decisions (#2707 step 2).
 * `approve`/`reject` delegate to the existing commands' exact behavior (the general-purpose
 * function underneath is the same `respondToWorkflow`, which is sugar over
 * `approveWorkflow`/`rejectWorkflow` for those two ids); any other declared decision always
 * resolves immediately and auto-resumes, mirroring `approve`'s shape.
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowRespondCommand(
  runId: string,
  decision: string,
  text?: string,
  json?: boolean,
  cwd?: string,
  detach?: boolean
): Promise<void> {
  if (decision === 'approve') return workflowApproveCommand(runId, text, json, cwd, detach);
  if (decision === 'reject') return workflowRejectCommand(runId, text, json, cwd, detach);

  // --detach: same shape as approve/reject — the parent validates read-only via the
  // SAME gate respondToWorkflow enforces, then hands the whole command to a detached
  // child. See runDetachedControlCommand's doc comment.
  if (detach) {
    const resolvedId = await resolveRunIdArg(runId, cwd);
    await runDetachedControlCommand(resolvedId, 'respond', json, cwd, async () => {
      const run = await workflowDb.getWorkflowRun(resolvedId);
      if (!run) {
        throw new Error(`Workflow run not found: ${resolvedId}`);
      }
      assertRespondable(run, decision);
      if (!run.working_path) {
        throw new Error(
          `Workflow run '${resolvedId}' has no working path recorded.\n` +
            'Cannot determine where to resume.'
        );
      }
      return run;
    });
    return;
  }

  // JSON mode records the decision and returns a structured ack WITHOUT the inline
  // auto-resume, mirroring approve/reject — drive it onward with a backgrounded
  // `resume`/`run --resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const result = await respondToWorkflow(resolvedId, decision, text);
      await writeJsonLine({
        ok: true,
        runId: resolvedId,
        action: 'respond',
        decision,
        workflowName: result.workflowName,
        resumable: true,
      });
    } catch (error) {
      await printJsonWriteError(runId, 'respond', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const result = await respondToWorkflow(resolvedId, decision, text);

  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${resolvedId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Responded '${decision}' to workflow: ${result.workflowName}`);
  console.log(`Path: ${result.workingPath}`);
  console.log('');
  console.log('Resuming workflow...');

  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = await conversationDb.getConversationById(result.conversationId);
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId: resolvedId, conversationId: result.conversationId },
        'cli.workflow_respond_conversation_not_found'
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId: resolvedId, conversationId: result.conversationId },
      'cli.workflow_respond_conversation_lookup_failed'
    );
  }

  try {
    // Use the codebase's source path for workflow YAML discovery so the file is
    // found even when working_path is a worktree or workspace clone that does
    // not contain the user's local (often untracked) workflow YAML.
    const discoveryCwd = result.codebaseId
      ? await resolveDiscoveryCwdForCodebase(resolvedId, result.codebaseId, 'respond')
      : undefined;

    await workflowRunCommand(result.workingPath, result.workflowName, result.userMessage ?? '', {
      // Continue from the source this run froze, not a fresh capture of the target.
      continuationRun: (await workflowDb.getWorkflowRun(resolvedId)) ?? undefined,
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
      discoveryCwd,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId: resolvedId, workflowName: result.workflowName },
      'cli.workflow_respond_resume_failed'
    );
    throw new Error(
      `Response recorded but failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The response was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`,
      { cause: err }
    );
  }
}

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter rules:
 *   - workflow-name required (positional)
 *   - --scope <key>: restrict to one scope (e.g. a conversation UUID); when
 *     omitted, deletes across ALL scopes (use --yes to skip the confirmation)
 *   - --node <id>: restrict to one node within the scope
 *   - --json: machine-readable output
 */
export async function workflowResetSessionsCommand(
  workflowName: string,
  options: { scope?: string; node?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  if (!options.scope && !options.yes) {
    throw new Error(
      `Refusing to delete every persisted session for workflow '${workflowName}' across all scopes without confirmation.\n` +
        'Pass --scope <key> to narrow, or --yes to confirm cross-scope reset.'
    );
  }
  try {
    const { deleted } = await resetWorkflowNodeSessions({
      workflow_name: workflowName,
      scope_key: options.scope,
      node_id: options.node,
    });
    if (options.json) {
      await writeStdout(
        `${JSON.stringify({
          workflow: workflowName,
          deleted,
          scope: options.scope ?? null,
          node: options.node ?? null,
        })}\n`
      );
    } else if (deleted === 0) {
      console.log(`No persisted sessions matched for workflow '${workflowName}'.`);
    } else {
      const scope = options.scope ? ` in scope '${options.scope}'` : ' across all scopes';
      const node = options.node ? ` for node '${options.node}'` : '';
      console.log(
        `Deleted ${deleted} persisted session(s) for workflow '${workflowName}'${node}${scope}.`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName, ...options }, 'cli.workflow_reset_sessions_failed');
    throw new Error(`Failed to reset workflow sessions: ${err.message}`);
  }
}

/**
 * Delete terminal workflow runs older than the given number of days.
 */
export async function workflowCleanupCommand(days: number): Promise<void> {
  try {
    const { count } = await workflowDb.deleteOldWorkflowRuns(days);
    if (count === 0) {
      console.log(`No workflow runs older than ${days} days to clean up.`);
    } else {
      console.log(`Deleted ${count} workflow run(s) older than ${days} days.`);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days }, 'cli.workflow_cleanup_failed');
    throw new Error(`Failed to clean up workflow runs: ${err.message}`);
  }
}

/**
 * Emit a workflow event directly to the database.
 * Event persistence mirrors createWorkflowEvent's fire-and-forget contract;
 * run-id resolution can still fail before the event reaches the store.
 */
export function isValidEventType(value: string): value is WorkflowEventType {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

export async function workflowEventEmitCommand(
  runId: string,
  eventType: WorkflowEventType,
  data?: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  const resolvedId = await resolveRunIdArg(runId, cwd, true);
  const store = createWorkflowStore();
  await store.createWorkflowEvent({
    workflow_run_id: resolvedId,
    event_type: eventType,
    data,
  });
  // createWorkflowEvent is non-throwing (fire-and-forget) — the event may not
  // have been persisted if the DB was unavailable. Check server logs if missing.
  console.log(`Event submitted (best-effort): ${eventType} for run ${resolvedId}`);
}

// ─── Marketplace commands ────────────────────────────────────────────────────

interface MarketplaceEntryJson {
  slug: string;
  name: string;
  author: string;
  description: string;
  sourceUrl: string;
  sha: string;
  tags: string[];
  archonVersionCompat: string;
  featured?: boolean;
}

const DEFAULT_MARKETPLACE_URL = 'https://archon.diy/workflows.json';

async function fetchMarketplace(): Promise<MarketplaceEntryJson[]> {
  const url = process.env.ARCHON_MARKETPLACE_URL ?? DEFAULT_MARKETPLACE_URL;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    const err = error as Error;
    throw new Error(`Cannot reach marketplace at ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Marketplace fetch failed: HTTP ${String(res.status)} from ${url}`);
  }
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected marketplace response format (expected array)');
  }
  for (const item of raw) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>).slug !== 'string' ||
      typeof (item as Record<string, unknown>).sourceUrl !== 'string' ||
      !Array.isArray((item as Record<string, unknown>).tags)
    ) {
      throw new Error('Marketplace response contains invalid entries');
    }
  }
  return raw as MarketplaceEntryJson[];
}

export async function workflowSearchCommand(query?: string, json?: boolean): Promise<void> {
  const entries = await fetchMarketplace();

  const results = query
    ? entries.filter(e => {
        const q = query.toLowerCase();
        return (
          e.name.toLowerCase().includes(q) ||
          e.author.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.tags.some(t => t.toLowerCase().includes(q))
        );
      })
    : entries;

  if (json) {
    await writeJsonLine(results);
    return;
  }

  if (results.length === 0) {
    console.log(query ? `No workflows matching "${query}".` : 'Marketplace is empty.');
    console.log('Browse at https://archon.diy/workflows/');
    return;
  }

  console.log(
    `\nWorkflow Marketplace${query ? ` — results for "${query}"` : ''} (${String(results.length)})\n`
  );
  for (const e of results) {
    const tags = e.tags.join(', ');
    const desc = e.description.length > 80 ? e.description.slice(0, 77) + '...' : e.description;
    console.log(`  ${e.slug}`);
    console.log(`    Name:   ${e.name}`);
    console.log(`    Author: @${e.author}`);
    console.log(`    Tags:   ${tags}`);
    console.log(`    ${desc}`);
    console.log('');
  }
  console.log('Install: archon workflow install <slug>');
}

/** Detect whether a sourceUrl points to a directory (tree URL) or a single file (blob URL). */
function isDirectoryUrl(sourceUrl: string): boolean {
  return sourceUrl.includes('/tree/');
}

/**
 * Validate that a path component from an external source is safe to use in a filesystem path.
 * Rejects names containing path separators, traversal sequences, or non-portable characters.
 */
function isSafePathComponent(name: string): boolean {
  return name !== '.' && name !== '..' && /^[a-zA-Z0-9._-]+$/.test(name);
}

/** Parse owner/repo and path from a GitHub blob or tree URL. */
function parseGitHubUrl(sourceUrl: string): { owner: string; repo: string; path: string } {
  // https://github.com/owner/repo/blob/ref/path or https://github.com/owner/repo/tree/ref/path
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(blob|tree)\/[^/]+\/(.+)$/.exec(
    sourceUrl
  );
  if (!match) {
    throw new Error(`Cannot parse GitHub URL: ${sourceUrl}`);
  }
  return { owner: match[1], repo: match[2], path: match[4] };
}

interface GitHubContentItem {
  name: string;
  type: 'file' | 'dir';
  download_url: string | null;
  path: string;
}

/** Fetch directory listing from GitHub Contents API at a pinned SHA. */
async function fetchGitHubDirectory(
  owner: string,
  repo: string,
  path: string,
  sha: string
): Promise<GitHubContentItem[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${sha}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/vnd.github.v3+json' } });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Cannot reach GitHub API: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API error: HTTP ${String(res.status)} from ${url}`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Expected directory listing from ${url}, got a single file`);
  }
  return data as GitHubContentItem[];
}

/** Download a file from raw.githubusercontent.com at a pinned SHA. */
async function downloadRawFile(
  owner: string,
  repo: string,
  filePath: string,
  sha: string
): Promise<string> {
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${filePath}`;
  let res: Response;
  try {
    res = await fetch(rawUrl);
  } catch (error) {
    const err = error as Error;
    throw new Error(`Cannot fetch ${rawUrl}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Source fetch failed: HTTP ${String(res.status)} from ${rawUrl}`);
  }
  return res.text();
}

export async function workflowInstallCommand(
  slug: string,
  cwd: string,
  force?: boolean
): Promise<void> {
  const entries = await fetchMarketplace();
  const entry = entries.find(e => e.slug === slug);

  if (!entry) {
    console.error(`Error: Workflow '${slug}' not found in marketplace.`);
    console.error("Run 'archon workflow search' to browse available workflows.");
    throw new Error(`Workflow '${slug}' not found`);
  }

  if (!entry.sourceUrl.startsWith('https://github.com/')) {
    throw new Error(
      `Untrusted source URL for '${slug}': ${entry.sourceUrl}\nOnly github.com sources are permitted.`
    );
  }

  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Invalid slug '${slug}': must be lowercase alphanumeric with hyphens only.`);
  }

  const { findRepoRoot } = await import('@archon/git');
  const repoRoot = await findRepoRoot(cwd);
  if (!repoRoot) {
    throw new Error('Not in a git repository. Run archon workflow install from within a git repo.');
  }

  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const archonDir = join(repoRoot, '.archon');

  if (isDirectoryUrl(entry.sourceUrl)) {
    await installDirectory(entry, slug, archonDir, force, existsSync, mkdirSync, writeFileSync);
  } else {
    await installSingleFile(entry, slug, archonDir, force, existsSync, mkdirSync, writeFileSync);
  }

  console.log(`Run with: archon workflow run ${slug} "<message>"`);
}

async function installSingleFile(
  entry: MarketplaceEntryJson,
  slug: string,
  archonDir: string,
  force: boolean | undefined,
  existsSync: (p: string) => boolean,
  mkdirSync: (p: string, opts: { recursive: boolean }) => void,
  writeFileSync: (p: string, data: string) => void
): Promise<void> {
  const { owner, repo, path } = parseGitHubUrl(entry.sourceUrl);
  const content = await downloadRawFile(owner, repo, path, entry.sha);

  if (!content.trim()) {
    throw new Error(`Downloaded YAML is empty for '${slug}'`);
  }

  const workflowsDir = join(archonDir, 'workflows');
  const destPath = join(workflowsDir, `${slug}.yaml`);

  if (existsSync(destPath) && !force) {
    throw new Error(`Workflow '${slug}' already exists at ${destPath}.\nUse --force to overwrite.`);
  }

  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(destPath, content);
  console.log(`Installed '${entry.name}' to ${destPath}`);
}

async function installDirectory(
  entry: MarketplaceEntryJson,
  slug: string,
  archonDir: string,
  force: boolean | undefined,
  existsSync: (p: string) => boolean,
  mkdirSync: (p: string, opts: { recursive: boolean }) => void,
  writeFileSync: (p: string, data: string) => void
): Promise<void> {
  const { owner, repo, path } = parseGitHubUrl(entry.sourceUrl);
  const items = await fetchGitHubDirectory(owner, repo, path, entry.sha);

  // Identify the main workflow YAML (named <slug>.yaml or the only .yaml in root)
  const yamlFiles = items.filter(f => f.type === 'file' && f.name.endsWith('.yaml'));
  const mainYaml =
    yamlFiles.find(f => f.name === `${slug}.yaml`) ??
    (yamlFiles.length === 1 ? yamlFiles[0] : undefined);

  if (!mainYaml) {
    throw new Error(
      `Cannot identify main workflow YAML in directory. Expected '${slug}.yaml' or a single .yaml file.`
    );
  }

  const workflowsDir = join(archonDir, 'workflows');
  const destWorkflow = join(workflowsDir, `${slug}.yaml`);

  if (existsSync(destWorkflow) && !force) {
    throw new Error(
      `Workflow '${slug}' already exists at ${destWorkflow}.\nUse --force to overwrite.`
    );
  }

  // Install the main workflow YAML
  const mainContent = await downloadRawFile(owner, repo, mainYaml.path, entry.sha);
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(destWorkflow, mainContent);
  console.log(`  Workflow: ${destWorkflow}`);

  // Install supporting files by convention
  const subdirs = items.filter(f => f.type === 'dir');
  let installedCount = 1;

  for (const subdir of subdirs) {
    if (!isSafePathComponent(subdir.name)) {
      console.log(`  Skipped (unsafe directory name): ${subdir.name}`);
      continue;
    }

    const subItems = await fetchGitHubDirectory(owner, repo, subdir.path, entry.sha);
    const files = subItems.filter(f => f.type === 'file');

    let targetDir: string;
    if (subdir.name === 'commands') {
      targetDir = join(archonDir, 'commands');
    } else if (subdir.name === 'scripts') {
      targetDir = join(archonDir, 'scripts');
    } else {
      // Other subdirs (e.g. skills) go under .archon/<dirname>
      targetDir = join(archonDir, subdir.name);
    }

    mkdirSync(targetDir, { recursive: true });

    for (const file of files) {
      if (!isSafePathComponent(file.name)) {
        console.log(`  Skipped (unsafe filename): ${file.name}`);
        continue;
      }
      const destFile = join(targetDir, file.name);
      if (existsSync(destFile) && !force) {
        console.log(`  Skipped (exists): ${destFile}`);
        continue;
      }
      const content = await downloadRawFile(owner, repo, file.path, entry.sha);
      writeFileSync(destFile, content);
      console.log(`  Installed: ${destFile}`);
      installedCount++;
    }
  }

  // Also install any other root-level non-YAML files (e.g. README)
  const otherRootFiles = items.filter(f => f.type === 'file' && !f.name.endsWith('.yaml'));
  for (const file of otherRootFiles) {
    if (!isSafePathComponent(file.name)) {
      console.log(`  Skipped (unsafe filename): ${file.name}`);
      continue;
    }
    const destFile = join(workflowsDir, file.name);
    if (existsSync(destFile) && !force) continue;
    const content = await downloadRawFile(owner, repo, file.path, entry.sha);
    writeFileSync(destFile, content);
    installedCount++;
  }

  console.log(`Installed '${entry.name}' (${String(installedCount)} files)`);
}
