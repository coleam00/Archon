/**
 * Workflow command - list and run workflows
 */
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
import { WORKFLOW_EVENT_TYPES, type WorkflowEventType } from '@archon/workflows/store';
import {
  isTierName,
  buildAiProfile,
  TIER_NAMES,
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
import {
  createLogger,
  getArchonHome,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
  readTierNoticeState,
  markTierNoticeShown,
} from '@archon/paths';
import { join } from 'node:path';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { executeWorkflow, hydrateResumableRun } from '@archon/workflows/executor';
import { assertWorkflowRequirementsMet } from '@archon/workflows/utils/workflow-requirements';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type {
  WorkflowDefinition,
  WorkflowLoadResult,
  WorkflowSource,
  WorkflowWithSource,
} from '@archon/workflows/schemas/workflow';
import { workflowRunStatusSchema, isApprovalContext } from '@archon/workflows/schemas/workflow-run';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import {
  approveWorkflow,
  rejectWorkflow,
  resumeWorkflow as resumeWorkflowOp,
  abandonWorkflow,
  getWorkflowStatus,
  resetWorkflowNodeSessions,
} from '@archon/core/operations/workflow-operations';
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
import { resolveCliUserId } from './auth';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.workflow');
  return cachedLog;
}

/**
 * Options for workflow run command
 *
 * Default: creates worktree with auto-generated branch name (isolation by default).
 * --branch: explicit branch name for the worktree.
 * --no-worktree: opt out of isolation, run in live checkout.
 * --resume: reuse worktree from last failed run.
 * --from: override base branch (start-point for worktree).
 *
 * Mutually exclusive: --branch + --no-worktree, --resume + --branch.
 */
export interface WorkflowRunOptions {
  branchName?: string;
  fromBranch?: string;
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
   * Override the directory used for workflow YAML discovery.
   * Pass `codebase.default_cwd` here so the source repo is searched even when
   * `working_path` is a worktree or workspace clone that lacks the file.
   */
  discoveryCwd?: string;
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
 * Re-invoke `archon workflow run` (minus --detach/--json) as a detached
 * background child so the caller's shell returns immediately. Reconstructs the
 * current argv, drops `--detach` (the child runs in the foreground) and `--json`
 * (the parent already emitted the ack; the child should log normally to its log
 * file, not run silent), pins `--cwd` (absolute) plus any caller-supplied extra
 * flags (a generated branch / conversation id), then detaches via `unref()`.
 *
 * `dispatchBackgroundWorkflow` is deliberately NOT reused here: it is web-
 * adapter-coupled and its fire-and-forget dies with the CLI process. The
 * re-invoke is the only mechanism that survives parent exit.
 *
 * Child stdout/stderr are redirected to a per-conversation log file under
 * ARCHON_HOME/logs so a child that fails BEFORE creating a run record (e.g. DB
 * unreachable, missing worktree) leaves a trail instead of failing silently.
 * Falls back to discarding output only if the log file cannot be opened.
 * Returns the log path (or null when discarded) so the caller can surface it.
 */
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
  // In a compiled binary, execPath IS the archon binary and there is no
  // entry-script argv[1]; in dev, execPath is bun and argv[1] is the cli entry.
  const baseCmd = isBinary ? [execPath] : [execPath, argv[1]];
  const userArgs = (isBinary ? argv.slice(1) : argv.slice(2)).filter(
    arg => arg !== '--detach' && arg !== '--json'
  );
  // --cwd is appended last (parseArgs last-wins) so the child resolves the same
  // absolute working dir regardless of any relative --cwd the caller passed.
  return [...baseCmd, ...userArgs, '--cwd', cwd, ...extraArgs];
}

function spawnDetachedWorkflowRun(
  cwd: string,
  conversationId: string,
  extraArgs: string[]
): string | null {
  const cmd = buildDetachedRunCmd(
    BUNDLED_IS_BINARY,
    process.execPath,
    process.argv,
    cwd,
    extraArgs
  );

  let logPath: string | null = null;
  let logFd: number | undefined;
  try {
    const logDir = join(getArchonHome(), 'logs');
    mkdirSync(logDir, { recursive: true });
    logPath = join(logDir, `detached-run-${conversationId}.log`);
    logFd = openSync(logPath, 'a');
  } catch (error) {
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
      env: process.env,
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
    child.unref();
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

/** Error for --branch/--from used against a folder project (no worktree). */
function folderWorktreeOptionError(): Error {
  return new Error(
    'Worktree options require a git-repo project.\n' +
      '  --branch/--from create an isolated git worktree, which folder projects do not use.\n' +
      '  Drop --branch/--from — folder projects always run in place.'
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
 * Fail fast if `--branch`/`--from` (git-worktree-only options) are used against a
 * folder project. Called at three sites — flag-declared (pre-detach), the detach
 * fast-path, and post-lookup (authoritative) — so the check lives in one place.
 */
function assertNoWorktreeOptionsForFolder(
  isFolderProject: boolean,
  options: WorkflowRunOptions
): void {
  if (isFolderProject && (options.branchName !== undefined || options.fromBranch !== undefined)) {
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

/**
 * Resolve the provider used for CLI conversation titles from the workflow itself.
 * This keeps auxiliary title generation aligned with workflow execution instead
 * of falling back to a stale conversation default.
 */
function resolveTitleAssistantType(
  workflow: WorkflowDefinition,
  defaultAssistant: string | undefined,
  conversationAssistant: string | undefined
): string {
  // Per CLAUDE.md, provider is resolved via an explicit chain:
  // node.provider ?? workflow.provider ?? config.assistant. Model never
  // influences provider selection — vendor SDKs add new model names faster
  // than we can keep a mapping in sync.
  const fallbackAssistant = defaultAssistant ?? conversationAssistant ?? 'claude';
  if (workflow.provider) return workflow.provider;
  return fallbackAssistant;
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

  const lines: string[] = [
    "ℹ️  This workflow uses model tiers (small/medium/large). You haven't configured them —",
    `   using built-in defaults for '${effectiveAssistant}':`,
  ];
  for (const t of TIER_NAMES) {
    const preset = aliases[t];
    if (preset) lines.push(`     ${t.padEnd(7)} → ${preset.provider}/${preset.model}`);
  }
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
        process.stderr.write(`[${event.stepName}] tool: ${event.toolName} (started)\n`);
      }
      break;
    case 'tool_completed':
      if (verbose) {
        process.stderr.write(
          `[${event.stepName}] tool: ${event.toolName} (${String(event.durationMs)}ms)\n`
        );
      }
      break;
    default:
      // Workflow-level, loop, artifact, and cancelled events are intentionally not rendered.
      break;
  }
}

/**
 * Load workflows from cwd with standardized error handling.
 * Returns the WorkflowLoadResult with both workflows and errors.
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
  modelReasoningEffort?: string;
  webSearchMode?: string;
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(cwd: string, json?: boolean): Promise<void> {
  const { workflows: workflowEntries, errors } = await loadWorkflows(cwd);

  if (json) {
    const output = {
      workflows: workflowEntries.map(({ workflow: w }) => {
        const entry: WorkflowJsonEntry = {
          name: w.name,
          description: w.description,
        };
        if (w.provider !== undefined) entry.provider = w.provider;
        if (w.model !== undefined) entry.model = w.model;
        if (w.modelReasoningEffort !== undefined)
          entry.modelReasoningEffort = w.modelReasoningEffort;
        if (w.webSearchMode !== undefined) entry.webSearchMode = w.webSearchMode;
        return entry;
      }),
      errors: errors.map(e => ({
        filename: e.filename,
        error: e.error,
        errorType: e.errorType,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
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

    for (const { workflow } of workflowEntries) {
      console.log(`  ${workflow.name}`);
      console.log(`    ${workflow.description}`);
      if (workflow.provider) {
        console.log(`    Provider: ${workflow.provider}`);
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
 * Run a specific workflow
 */
export async function workflowRunCommand(
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {}
): Promise<void> {
  const effectiveDiscoveryCwd = options.discoveryCwd ?? cwd;
  const { workflows: workflowEntries, errors } = await loadWorkflows(effectiveDiscoveryCwd);
  const sourceCounts = countWorkflowSources(workflowEntries);

  if (!options.json && !options.quiet) {
    console.log(
      `Discovery: root=${effectiveDiscoveryCwd} workflows=${String(workflowEntries.length)} ` +
        `bundled=${String(sourceCounts.bundled)} global=${String(sourceCounts.global)} ` +
        `project=${String(sourceCounts.project)}`
    );
  }

  if (workflowEntries.length === 0 && errors.length === 0) {
    throw new Error('No workflows found in .archon/workflows/');
  }

  const workflows = workflowEntries.map(ws => ws.workflow);

  const workflow = resolveWorkflowName(workflowName, workflows);
  // Recover the discovery source (dropped by the .map above) for telemetry —
  // bundled workflows report their real name, custom ones report "custom".
  const workflowSource = workflow
    ? workflowEntries.find(ws => ws.workflow === workflow)?.source
    : undefined;

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
  if (options.resume && options.branchName !== undefined) {
    throw new Error(
      '--resume and --branch are mutually exclusive.\n' +
        '  --resume reuses the existing worktree from the failed run.\n' +
        '  Remove --branch when using --resume.'
    );
  }

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
  const wantsIsolation =
    !options.resume && pinnedEnabled !== undefined ? pinnedEnabled : flagWantsIsolation;

  // Worktree options require a git repo. When the caller explicitly declares
  // folder intent via --folder, reject --branch/--from and worktree-pinned
  // workflows synchronously (no DB needed). The authoritative kind-based guard
  // for ALREADY-registered folder projects (no --folder flag) lives after the
  // codebase lookup below. Fail fast — never silently ignore the flags.
  assertNoWorktreeOptionsForFolder(options.folder === true, options);
  assertWorkflowNotWorktreePinnedForFolder(options.folder === true, pinnedEnabled, workflow.name);

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
    const childConversationId = options.conversationId ?? generateConversationId();
    const extraArgs: string[] = [];
    let pinnedBranch: string | undefined;
    // Determine folder-ness so we never pin a worktree branch on the child for a
    // folder project. The --folder flag signals it directly; an already-registered
    // folder project (no flag) is detected via a read-only DB lookup. This lookup
    // only runs on the detach fast-path (which returns immediately), so the
    // non-detach path keeps a single authoritative codebase lookup below.
    // Non-fatal: a DB hiccup falls back to the normal repo path.
    let detachIsFolder = options.folder === true;
    if (!detachIsFolder) {
      try {
        const existing =
          (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
          (await codebaseDb.findCodebaseByPathPrefix(cwd));
        if (existing?.kind === 'folder') detachIsFolder = true;
      } catch (err) {
        getLog().debug({ err: err as Error, cwd }, 'cli.folder_detect_probe_failed');
      }
    }
    // Surface worktree-option conflicts synchronously in the parent rather than
    // letting the child fail after fork.
    assertNoWorktreeOptionsForFolder(detachIsFolder, options);
    // Pin a generated branch only when isolating AND the caller didn't pass
    // --branch (an explicit --branch is already in argv). Without this, the child
    // would generate its own timestamped branch and fork a second worktree.
    // Never pin a branch for folder projects — they run in place with no worktree.
    if (wantsIsolation && !detachIsFolder && options.branchName === undefined) {
      pinnedBranch = `${workflowName}-${String(Date.now())}`;
      extraArgs.push('--branch', pinnedBranch);
    }
    // Pin the conversation id only when generated (an explicit one is already in argv).
    if (options.conversationId === undefined) {
      extraArgs.push('--conversation-id', childConversationId);
    }

    const logPath = spawnDetachedWorkflowRun(cwd, childConversationId, extraArgs);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            action: 'run',
            detached: true,
            workflow: workflow.name,
            branch: pinnedBranch ?? options.branchName ?? null,
            conversationId: childConversationId,
            logPath,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Started '${workflow.name}' in the background.`);
      console.log('Track it with: archon workflow runs');
      if (logPath) {
        console.log(`Child output: ${logPath}`);
      } else {
        // Log file couldn't be opened — the child runs with its output discarded,
        // so if it dies before creating a run record there will be no trail.
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

  // Try to find a codebase for this directory. Mirror the `run` dispatch gate
  // (cli.ts) and the --detach folder probe above: exact `default_cwd` match
  // first, then a path-prefix lookup so a subdirectory or worktree UNDER a
  // registered root resolves to its covering codebase. Without the prefix
  // fallback, resume/approve re-enter here with cwd = the run's worktree
  // working_path, miss the exact match, and fall through to auto-registration —
  // which trips the source-symlink guard for an already-covered path (#2127).
  let codebase = null;
  let codebaseLookupError: Error | null = null;
  let codebaseRegistrationError: Error | null = null;
  try {
    codebase =
      (await codebaseDb.findCodebaseByDefaultCwd(cwd)) ??
      (await codebaseDb.findCodebaseByPathPrefix(cwd));
  } catch (error) {
    const err = error as Error;
    codebaseLookupError = err;
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
  if (!codebase && !codebaseLookupError && options.codebaseId) {
    try {
      codebase = await codebaseDb.getCodebase(options.codebaseId);
    } catch (error) {
      const err = error as Error;
      getLog().warn(
        { err, errorType: err.constructor.name, codebaseId: options.codebaseId },
        'cli.codebase_id_lookup_failed'
      );
      // Intentional: don't set codebaseLookupError — fall through to auto-registration
    }
  }

  // Auto-register unregistered repos (creates project structure for artifacts/logs)
  if (!codebase && !codebaseLookupError) {
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
        codebaseRegistrationError = err;
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
          console.log(`Registered folder project "${result.name}" (${result.defaultCwd})`);
          getLog().info({ name: result.name }, 'cli.folder_project_auto_registered');
        }
      } catch (error) {
        const err = error as Error;
        codebaseRegistrationError = err;
        getLog().warn(
          { err, errorType: err.constructor.name, cwd },
          'cli.folder_project_auto_registration_failed'
        );
      }
    }
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

    resumable = await workflowDb.findResumableRun(workflowName, cwd);

    if (!resumable) {
      throw new Error(`No resumable run found for workflow '${workflowName}' at path '${cwd}'.`);
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
          prepared = await backend.prepare({ codebase: folderCodebase });
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
      // Validate base branch before reuse (warning-only — non-blocking)
      try {
        const repoConfig = await loadRepoConfig(codebase.default_cwd);
        const rawBase = repoConfig?.worktree?.baseBranch?.trim();
        // Three-level fallback: repo config → codebase default → git auto-detect.
        let configuredBase: git.BranchName;
        if (rawBase) {
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
        fromBranch: options.fromBranch?.trim()
          ? git.toBranchName(options.fromBranch.trim())
          : undefined,
        baseBranch: codebaseDefaultBranch ? git.toBranchName(codebaseDefaultBranch) : undefined,
        codebaseId: codebase.id,
        // owner/repo name lets resolveOwnerRepo skip the path heuristic, which
        // throws for single-segment checkout paths like /workspace (#2022)
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
    // Isolation was expected (default) but codebase is unavailable — fail fast
    if (codebaseLookupError) {
      throw new Error(
        'Cannot create worktree: database lookup failed.\n' +
          `Error: ${codebaseLookupError.message}\n` +
          'Hint: Check your database connection, or use --no-worktree to skip isolation.'
      );
    }
    if (codebaseRegistrationError) {
      throw buildRegistrationFailureError('create worktree', codebaseRegistrationError);
    }
    throw new Error(
      'Cannot create worktree: not in a git repository.\n' +
        'Run from within a git repo, or use --no-worktree to skip isolation.'
    );
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
  const cliId = resolveCliUserId();
  let cliUserId: string | undefined;
  if (cliId) {
    try {
      const cliUser = await userDb.findOrCreateUserByPlatformIdentity('cli', cliId, cliId);
      cliUserId = cliUser.id;
    } catch (error) {
      getLog().warn({ err: error as Error, cliId }, 'cli.user_identity_resolve_failed');
    }
  }

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
        workflow,
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

  // Register cleanup handlers for graceful termination
  let terminating = false;
  const cleanup = (signal: string): void => {
    if (terminating) return;
    terminating = true;
    getLog().info({ conversationId: conversation.id, signal }, 'workflow.process_terminating');
    workflowDb
      .getActiveWorkflowRun(conversation.id)
      .then(activeRun => {
        if (activeRun) {
          return workflowDb.failWorkflowRun(activeRun.id, `Process terminated (${signal})`);
        }
        return undefined;
      })
      .catch((err: unknown) => {
        const e = err as Error;
        getLog().error(
          { err: e, errorType: e.constructor.name },
          'workflow.termination_cleanup_failed'
        );
      })
      // Destroy the isolation container so Ctrl-C / SIGTERM doesn't orphan a
      // PRIVILEGED container — `process.exit(1)` below bypasses the teardown
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
      .catch(() => undefined)
      .finally(() => {
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => {
    cleanup('SIGTERM');
  });
  process.once('SIGINT', () => {
    cleanup('SIGINT');
  });

  // One-time-per-version notice when the workflow uses unconfigured tier keywords.
  await maybePrintTierNotice(workflow, workingCwd, cliUserId, options.quiet);

  // Subscribe to workflow events for progress rendering on stderr.
  // subscribeForConversation is pure in-memory registration — cannot throw in practice.
  // If that changes, this should be moved inside the try block to prevent blocking executeWorkflow.
  const { quiet, verbose } = options;
  const unsubscribe = quiet
    ? undefined
    : getWorkflowEventEmitter().subscribeForConversation(conversationId, event => {
        renderWorkflowEvent(event, verbose ?? false);
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
  try {
    const opts = prepared
      ? {
          codebaseId: codebase?.id,
          source: workflowSource,
          userId: cliUserId,
          baseBranch: codebaseDefaultBranch,
          execContext,
          container: containerRunCtx,
          ...prepared,
        }
      : {
          codebaseId: codebase?.id,
          source: workflowSource,
          userId: cliUserId,
          baseBranch: codebaseDefaultBranch,
          execContext,
          container: containerRunCtx,
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
    unsubscribe?.();

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
    throw new Error(`Workflow failed: ${result.error}`);
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

interface NodeSummary {
  nodeId: string;
  state: 'running' | 'completed' | 'failed' | 'skipped';
  durationMs?: number;
  outputPreview?: string;
  error?: string;
}

/**
 * Derive per-node summaries from a run's workflow events.
 * Processes node_started / node_completed / node_failed / node_skipped* events.
 */
function buildNodeSummaries(events: WorkflowEventRow[]): NodeSummary[] {
  const startTimes = new Map<string, number>();
  const summaries = new Map<string, NodeSummary>();

  for (const event of events) {
    const nodeId = event.step_name;
    if (!nodeId) continue;

    switch (event.event_type) {
      case 'node_started': {
        startTimes.set(nodeId, new Date(event.created_at).getTime());
        if (!summaries.has(nodeId)) {
          summaries.set(nodeId, { nodeId, state: 'running' });
        }
        break;
      }
      case 'node_completed': {
        const started = startTimes.get(nodeId);
        const endTime = new Date(event.created_at).getTime();
        const rawOutput = event.data.node_output;
        const output = typeof rawOutput === 'string' ? rawOutput : undefined;
        summaries.set(nodeId, {
          nodeId,
          state: 'completed',
          durationMs: started !== undefined ? endTime - started : undefined,
          outputPreview:
            output !== undefined
              ? output.slice(0, 200) + (output.length > 200 ? '...' : '')
              : undefined,
        });
        break;
      }
      case 'node_failed': {
        const started = startTimes.get(nodeId);
        const endTime = new Date(event.created_at).getTime();
        summaries.set(nodeId, {
          nodeId,
          state: 'failed',
          durationMs: started !== undefined ? endTime - started : undefined,
          error: typeof event.data.error === 'string' ? event.data.error : 'Unknown error',
        });
        break;
      }
      case 'node_skipped':
      case 'node_skipped_prior_success': {
        summaries.set(nodeId, { nodeId, state: 'skipped' });
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
 * silenced; the empty `events` array is the documented signal there.)
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
export async function workflowStatusCommand(json?: boolean, verbose?: boolean): Promise<void> {
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
    let runsOutput: unknown[] = runs;
    if (verbose) {
      const eventsPerRun = await Promise.all(
        runs.map(run =>
          workflowEventsDb.listWorkflowEvents(run.id).catch(() => [] as WorkflowEventRow[])
        )
      );
      runsOutput = runs.map((run, i) => ({ ...run, events: eventsPerRun[i] }));
    }
    console.log(JSON.stringify({ runs: runsOutput }, null, 2));
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
 * Show detail for a single workflow run by ID (any status).
 *
 * Unlike `status` (active runs only), this resolves one run regardless of
 * status — so an agent can answer "did the review pass?" for a completed/failed
 * run. `--verbose` adds the per-node event summary; `--json` emits the raw run
 * (plus an `events` array when verbose).
 *
 * `runId` may be the short id printed by `workflow runs` (see resolveRunIdArg).
 */
export async function workflowGetCommand(
  runId: string,
  json?: boolean,
  verbose?: boolean,
  cwd?: string
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
      console.log(JSON.stringify({ ok: false, runId, error: err.message }, null, 2));
      return 1;
    }
    throw new Error(`Failed to get workflow run: ${err.message}`);
  }

  if (!run) {
    // Not-found exits non-zero so `get <id> && ...` and CI checks see the
    // failure (the JSON envelope already carries ok:false for parsers).
    if (json) {
      console.log(JSON.stringify({ ok: false, runId, error: 'not_found' }, null, 2));
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

  if (json) {
    const output = verbose ? { ...run, events: events ?? [] } : run;
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  console.log(`  ID:     ${run.id}`);
  console.log(`  Name:   ${run.workflow_name}`);
  console.log(`  Path:   ${run.working_path ?? '(none)'}`);
  console.log(`  Status: ${run.status}`);
  console.log(`  Age:    ${formatAge(run.started_at)}`);
  // Paused interactive-loop gate: one honest line so a human (or an agent parsing
  // the plain output) sees whether the paused iteration emitted its completion
  // signal (#2074). --json already carries the full metadata.approval.
  const gateMeta = run.metadata.approval;
  if (
    run.status === 'paused' &&
    isApprovalContext(gateMeta) &&
    gateMeta.type === 'interactive_loop'
  ) {
    const signal = gateMeta.completionSignaled === true ? 'yes' : 'no';
    console.log(
      `  Gate:   awaiting approval — signal detected: ${signal} (iteration ${String(gateMeta.iteration ?? '?')})`
    );
  }
  const runError = typeof run.metadata.error === 'string' ? run.metadata.error : undefined;
  if (runError) {
    console.log(`  Error:  ${runError}`);
  }
  if (events) {
    if (eventsFailed) {
      console.log('  (node events unavailable — see logs)');
    }
    printVerboseNodes(events);
  }
  return 0;
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
  opts: { json?: boolean; all?: boolean; status?: string; limit?: number } = {}
): Promise<void> {
  let statusFilter: WorkflowRunStatus | undefined;
  if (opts.status) {
    const parsed = workflowRunStatusSchema.safeParse(opts.status);
    if (!parsed.success) {
      const msg = `Invalid --status '${opts.status}'. Valid: ${workflowRunStatusSchema.options.join(', ')}.`;
      // --json never throws — emit one parseable {ok:false} line (write-command contract).
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        return;
      }
      throw new Error(msg);
    }
    statusFilter = parsed.data;
  }

  // Scope to this project by resolving the codebase from cwd (mirror
  // workflowRunCommand). --all opts out of scoping. A lookup failure or an
  // unregistered cwd both fall back to the global list — never a silent
  // wrong-scope (the human path prints an explicit note below).
  let codebase = null;
  if (!opts.all) {
    try {
      codebase = await codebaseDb.findCodebaseByDefaultCwd(cwd);
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
      console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
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
    console.log(JSON.stringify({ ...result, scopeFallback }, null, 2));
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
function printJsonWriteError(runId: string, action: string, error: unknown): void {
  console.log(
    JSON.stringify({ ok: false, runId, action, error: (error as Error).message }, null, 2)
  );
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
 * keep working from any directory. When `cwd` is omitted, the cwd is not a
 * registered project, or the prefix matches nothing in this project, the
 * argument passes through unchanged so the downstream exact lookup keeps its
 * existing error surface (intentional fallback: it preserves behavior for
 * runs of other projects and non-UUID ids rather than guessing).
 */
async function resolveRunIdArg(runId: string, cwd?: string): Promise<string> {
  if (cwd === undefined || FULL_RUN_ID_RE.test(runId)) return runId;
  const codebase = await codebaseDb.findCodebaseByDefaultCwd(cwd);
  if (!codebase) return runId;
  const matches = await workflowDb.findWorkflowRunsByIdPrefix(runId, codebase.id);
  if (matches.length > 1) {
    throw new Error(
      `Run id '${runId}' matches more than one run in this project — use more characters or the full id (from 'archon workflow runs --json').`
    );
  }
  return matches[0]?.id ?? runId;
}

async function resolveDiscoveryCwdForCodebase(
  runId: string,
  codebaseId: string,
  action: 'resume' | 'approve' | 'reject'
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
  cwd?: string
): Promise<void> {
  // JSON mode is a non-blocking control-plane ack: validate the run is resumable
  // and report its state, but do NOT re-execute the workflow inline (execution
  // streams workflow output to stdout, which would corrupt the JSON contract).
  // To actually execute a resumable run, use the blocking `resume` (no --json,
  // run as a background task) or `run <name> --resume --detach`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const run = await resumeWorkflowOp(resolvedId);
      console.log(
        JSON.stringify(
          {
            ok: true,
            runId: resolvedId,
            action: 'resume',
            executed: false,
            status: run.status,
            workflowName: run.workflow_name,
            workingPath: run.working_path,
          },
          null,
          2
        )
      );
    } catch (error) {
      printJsonWriteError(runId, 'resume', error);
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
    throw new Error(`Failed to resume workflow '${run.workflow_name}': ${err.message}`);
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
      const run = await abandonWorkflow(resolvedId);
      console.log(
        JSON.stringify(
          {
            ok: true,
            runId: resolvedId,
            action: 'abandon',
            status: 'cancelled',
            workflowName: run.workflow_name,
          },
          null,
          2
        )
      );
    } catch (error) {
      printJsonWriteError(runId, 'abandon', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const run = await abandonWorkflow(resolvedId);
  console.log(`Abandoned workflow run: ${resolvedId}`);
  console.log(`Workflow: ${run.workflow_name}`);
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
  cwd?: string
): Promise<void> {
  // JSON mode records the approval and returns a structured ack WITHOUT the
  // inline auto-resume (resuming executes the workflow and streams output to
  // stdout, which would corrupt the JSON contract). The run becomes resumable
  // — drive it to completion with a backgrounded `resume`/`run --resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const result = await approveWorkflow(resolvedId, comment);
      console.log(
        JSON.stringify(
          {
            ok: true,
            runId: resolvedId,
            action: 'approve',
            type: result.type,
            workflowName: result.workflowName,
            resumable: true,
          },
          null,
          2
        )
      );
    } catch (error) {
      printJsonWriteError(runId, 'approve', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const result = await approveWorkflow(resolvedId, comment);

  // CLI auto-resumes after approval (unlike chat, which defers to next user message)
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
        `The approval was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`
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
  cwd?: string
): Promise<void> {
  // JSON mode records the rejection and returns a structured ack WITHOUT the
  // inline auto-resume (an on_reject rework executes the workflow and streams
  // to stdout, corrupting the JSON contract). When `cancelled` is false the run
  // is resumable for the rework pass — drive it with a backgrounded `resume`.
  if (json) {
    try {
      const resolvedId = await resolveRunIdArg(runId, cwd);
      const result = await rejectWorkflow(resolvedId, reason);
      console.log(
        JSON.stringify(
          {
            ok: true,
            runId: resolvedId,
            action: 'reject',
            cancelled: result.cancelled,
            maxAttemptsReached: result.maxAttemptsReached,
            workflowName: result.workflowName,
            resumable: !result.cancelled,
          },
          null,
          2
        )
      );
    } catch (error) {
      printJsonWriteError(runId, 'reject', error);
    }
    return;
  }

  const resolvedId = await resolveRunIdArg(runId, cwd);
  const result = await rejectWorkflow(resolvedId, reason);

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    return;
  }

  // Not cancelled = either an on_reject rework (DAG approval gate) or a container
  // write-back reject (discard the overlay). Both auto-resume; the resume drives
  // the rework / the overlay discard + completion.
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
        `The rejection was recorded. Run 'bun run cli workflow resume ${resolvedId}' to retry.`
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
      console.log(
        JSON.stringify({
          workflow: workflowName,
          deleted,
          scope: options.scope ?? null,
          node: options.node ?? null,
        })
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
 * Non-throwing: mirrors the fire-and-forget contract of createWorkflowEvent.
 */
export function isValidEventType(value: string): value is WorkflowEventType {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

export async function workflowEventEmitCommand(
  runId: string,
  eventType: WorkflowEventType,
  data?: Record<string, unknown>
): Promise<void> {
  const store = createWorkflowStore();
  await store.createWorkflowEvent({
    workflow_run_id: runId,
    event_type: eventType,
    data,
  });
  // createWorkflowEvent is non-throwing (fire-and-forget) — the event may not
  // have been persisted if the DB was unavailable. Check server logs if missing.
  console.log(`Event submitted (best-effort): ${eventType} for run ${runId}`);
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
    console.log(JSON.stringify(results, null, 2));
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
