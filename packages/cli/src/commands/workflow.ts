/**
 * Workflow command - list and run workflows
 */
import {
  registerRepository,
  loadConfig,
  loadRepoConfig,
  generateAndSetTitle,
  createWorkflowStore,
} from '@archon/core';
import { WORKFLOW_EVENT_TYPES, type WorkflowEventType } from '@archon/workflows/store';
import { configureIsolation, getIsolationProvider } from '@archon/isolation';
import { createLogger, getArchonHome } from '@archon/paths';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { executeWorkflow } from '@archon/workflows/executor';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@archon/workflows/event-emitter';
import type { WorkflowLoadResult } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  approveWorkflow,
  rejectWorkflow,
  resumeWorkflow as resumeWorkflowOp,
  abandonWorkflow,
  getWorkflowStatus,
} from '@archon/core/operations/workflow-operations';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as messageDb from '@archon/core/db/messages';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventsDb from '@archon/core/db/workflow-events';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';
import * as git from '@archon/git';
import { CLIAdapter } from '../adapters/cli-adapter';

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
  resume?: boolean;
  codebaseId?: string; // Passed by resume/approve to skip path-based lookup
  quiet?: boolean;
  verbose?: boolean;
  /** Platform conversation ID (e.g. `cli-{ts}-{rand}`), NOT a DB UUID. */
  conversationId?: string;
}

/**
 * Generate a unique conversation ID for CLI usage
 */
function generateConversationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `cli-${String(timestamp)}-${random}`;
}

/** Render a workflow event to stderr as a progress line. Called only when --quiet is not set. */
function renderWorkflowEvent(event: WorkflowEmitterEvent, verbose: boolean): void {
  switch (event.type) {
    case 'node_started':
      process.stderr.write(`[${event.nodeName}] Started\n`);
      break;
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
    return await discoverWorkflowsWithConfig(cwd, loadConfig, {
      globalSearchPath: getArchonHome(),
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Error loading workflows: ${err.message}\nHint: Check permissions on .archon/workflows/ directory.`
    );
  }
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
    console.log(`\nFound ${String(workflowEntries.length)} workflow(s):\n`);

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
    console.log(`\n${String(errors.length)} workflow(s) failed to load:\n`);
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
  const { workflows: workflowEntries, errors } = await loadWorkflows(cwd);

  if (workflowEntries.length === 0 && errors.length === 0) {
    throw new Error('No workflows found in .archon/workflows/');
  }

  const workflows = workflowEntries.map(ws => ws.workflow);

  const workflow = resolveWorkflowName(workflowName, workflows);

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

  // Try to find a codebase for this directory
  let codebase = null;
  let codebaseLookupError: Error | null = null;
  try {
    codebase = await codebaseDb.findCodebaseByDefaultCwd(cwd);
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
        getLog().warn(
          { err, errorType: err.constructor.name, repoRoot },
          'cli.codebase_auto_registration_failed'
        );
      }
    }
  }

  // Handle isolation (worktree creation)
  let workingCwd = cwd;
  let isolationEnvId: string | undefined;

  // Handle --resume: find the most recent failed run and reuse its worktree.
  // The executor's implicit findResumableRun will detect the failed run and
  // skip already-completed nodes automatically.
  if (options.resume) {
    if (!codebase) {
      if (codebaseLookupError) {
        throw new Error(
          'Cannot resume: Database lookup failed.\n' +
            `Error: ${codebaseLookupError.message}\n` +
            'Hint: Check your database connection before using --resume.'
        );
      }
      throw new Error(
        'Cannot resume: Not in a git repository.\n' +
          'Either run from a git repo or use /clone first.'
      );
    }

    const resumable = await workflowDb.findResumableRun(workflowName, cwd);

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

  // Default to worktree isolation unless --no-worktree or --resume
  const wantsIsolation = !options.resume && !options.noWorktree;

  if (wantsIsolation && codebase) {
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
        const rawBase = repoConfig?.worktree?.baseBranch;
        const configuredBase = rawBase
          ? git.toBranchName(rawBase)
          : await git.getDefaultBranch(git.toRepoPath(codebase.default_cwd));
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
        codebaseId: codebase.id,
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

  // Persist user message for Web UI history
  try {
    await messageDb.addMessage(conversation.id, 'user', userMessage);
  } catch (error) {
    getLog().warn(
      { err: error as Error, conversationId: conversation.id },
      'cli_user_message_persist_failed'
    );
  }

  // Auto-generate title for CLI workflow conversations (fire-and-forget)
  void generateAndSetTitle(
    conversation.id,
    userMessage,
    conversation.ai_assistant_type,
    workingCwd,
    workflowName
  );

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

  // Subscribe to workflow events for progress rendering on stderr.
  // subscribeForConversation is pure in-memory registration — cannot throw in practice.
  // If that changes, this should be moved inside the try block to prevent blocking executeWorkflow.
  const { quiet, verbose } = options;
  const unsubscribe = quiet
    ? undefined
    : getWorkflowEventEmitter().subscribeForConversation(conversationId, event => {
        renderWorkflowEvent(event, verbose ?? false);
      });

  // Execute workflow with workingCwd (may be worktree path)
  let result: Awaited<ReturnType<typeof executeWorkflow>>;
  try {
    result = await executeWorkflow(
      createWorkflowDeps(),
      adapter,
      conversationId,
      workingCwd,
      workflow,
      userMessage,
      conversation.id,
      codebase?.id
    );
  } finally {
    unsubscribe?.();
  }

  // Check result and exit appropriately
  if (result.success && 'paused' in result && result.paused) {
    console.log('\nWorkflow paused — waiting for approval.');
  } else if (result.success) {
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
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${String(mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ${String(mins % 60)}m`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ${String(hours % 24)}h`;
}

/**
 * Format a duration in milliseconds as a compact string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const secs = Math.round(ms / 100) / 10;
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${String(mins)}m${String(remSecs)}s`;
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
    if (verbose) {
      const eventsPerRun = await Promise.all(
        runs.map(run =>
          workflowEventsDb.listWorkflowEvents(run.id).catch(() => [] as WorkflowEventRow[])
        )
      );
      const runsWithEvents = runs.map((run, i) => ({
        ...run,
        events: eventsPerRun[i],
      }));
      console.log(JSON.stringify({ runs: runsWithEvents }, null, 2));
    } else {
      console.log(JSON.stringify({ runs }, null, 2));
    }
    return;
  }

  if (runs.length === 0) {
    console.log('No active workflows.');
    return;
  }

  console.log(`\nActive workflows (${String(runs.length)}):\n`);
  for (const run of runs) {
    const age = formatAge(run.started_at);
    console.log(`  ID:     ${run.id}`);
    console.log(`  Name:   ${run.workflow_name}`);
    console.log(`  Path:   ${run.working_path ?? '(none)'}`);
    console.log(`  Status: ${run.status}`);
    console.log(`  Age:    ${age}`);

    if (verbose) {
      let events: WorkflowEventRow[];
      try {
        events = await workflowEventsDb.listWorkflowEvents(run.id);
      } catch {
        events = [];
      }
      const nodes = buildNodeSummaries(events);
      if (nodes.length > 0) {
        console.log('  Nodes:');
        for (const node of nodes) {
          const iconMap: Record<string, string> = {
            completed: '✓',
            failed: '✗',
            skipped: '-',
            running: '◌',
          };
          const icon = iconMap[node.state] ?? '◌';
          const duration =
            node.durationMs !== undefined ? ` (${formatDuration(node.durationMs)})` : '';
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
    }

    console.log('');
  }
}

/**
 * Resume a failed workflow run by ID.
 *
 * Re-executes the workflow with --resume semantics — the executor's
 * findResumableRun picks up the prior failed run and skips completed nodes.
 */
export async function workflowResumeCommand(runId: string): Promise<void> {
  const run = await resumeWorkflowOp(runId);
  if (!run.working_path) {
    throw new Error(
      `Workflow run '${runId}' has no working path recorded.\n` +
        'Cannot determine where to resume. The run may be too old.'
    );
  }
  console.log(`Resuming workflow: ${run.workflow_name}`);
  console.log(`Path: ${run.working_path}`);
  console.log('');

  // Re-execute via workflowRunCommand with --resume.
  // The executor's implicit findResumableRun detects the prior failed run
  // and skips already-completed nodes.
  try {
    await workflowRunCommand(run.working_path, run.workflow_name, run.user_message ?? '', {
      resume: true,
      codebaseId: run.codebase_id ?? undefined,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId, workflowName: run.workflow_name },
      'cli.workflow_resume_run_failed'
    );
    throw new Error(`Failed to resume workflow '${run.workflow_name}': ${err.message}`);
  }
}

/**
 * Abandon a workflow run by ID (marks it as cancelled).
 */
export async function workflowAbandonCommand(runId: string): Promise<void> {
  const run = await abandonWorkflow(runId);
  console.log(`Abandoned workflow run: ${runId}`);
  console.log(`Workflow: ${run.workflow_name}`);
}

/**
 * Approve a paused workflow run by ID.
 * Writes the approval events and transitions to 'failed' for auto-resume.
 */
export async function workflowApproveCommand(runId: string, comment?: string): Promise<void> {
  const result = await approveWorkflow(runId, comment);

  // CLI auto-resumes after approval (unlike chat, which defers to next user message)
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${runId}' has no working path recorded.\n` +
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
        { runId, conversationId: result.conversationId },
        'cli.workflow_approve_conversation_not_found'
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId, conversationId: result.conversationId },
      'cli.workflow_approve_conversation_lookup_failed'
    );
  }

  try {
    await workflowRunCommand(result.workingPath, result.workflowName, result.userMessage ?? '', {
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId, workflowName: result.workflowName },
      'cli.workflow_approve_resume_failed'
    );
    throw new Error(
      `Approved but failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The approval was recorded. Run 'bun run cli workflow resume ${runId}' to retry.`
    );
  }
}

/**
 * Reject a paused workflow run by ID (marks it as cancelled).
 */
export async function workflowRejectCommand(runId: string, reason?: string): Promise<void> {
  const result = await rejectWorkflow(runId, reason);

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (max attempts reached)' : '';
    console.log(`Rejected and cancelled${suffix}: ${result.workflowName}`);
    return;
  }

  // Not cancelled = has onRejectPrompt, CLI auto-resumes with rejection feedback
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${runId}' has no working path recorded.\n` +
        'Cannot determine where to resume.'
    );
  }
  console.log(`Rejected workflow: ${result.workflowName}`);
  console.log('Resuming with on_reject prompt...');

  // Look up the original platform conversation ID to keep all messages in one thread
  let platformConversationId: string | undefined;
  try {
    const originalConversation = await conversationDb.getConversationById(result.conversationId);
    platformConversationId = originalConversation?.platform_conversation_id ?? undefined;
    if (!originalConversation) {
      getLog().info(
        { runId, conversationId: result.conversationId },
        'cli.workflow_reject_conversation_not_found'
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, runId, conversationId: result.conversationId },
      'cli.workflow_reject_conversation_lookup_failed'
    );
  }

  try {
    await workflowRunCommand(result.workingPath, result.workflowName, result.userMessage ?? '', {
      resume: true,
      codebaseId: result.codebaseId ?? undefined,
      conversationId: platformConversationId,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error(
      { err, runId, workflowName: result.workflowName },
      'cli.workflow_reject_resume_failed'
    );
    throw new Error(
      `Rejected but failed to resume workflow '${result.workflowName}': ${err.message}\n` +
        `The rejection was recorded. Run 'bun run cli workflow resume ${runId}' to retry.`
    );
  }
}

/**
 * Delete terminal workflow runs older than the given number of days.
 */
export async function workflowCleanupCommand(days: number): Promise<void> {
  try {
    const { count } = await workflowDb.deleteOldWorkflowRuns(days);
    if (count === 0) {
      console.log(`No workflow runs older than ${String(days)} days to clean up.`);
    } else {
      console.log(`Deleted ${String(count)} workflow run(s) older than ${String(days)} days.`);
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
