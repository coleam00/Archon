/**
 * Workflow command - list and run workflows
 */
import {
  registerRepository,
  loadConfig,
  loadRepoConfig,
  generateAndSetTitle,
  createWorkflowStore,
} from '@harneeslab/core';
import { WORKFLOW_EVENT_TYPES, type WorkflowEventType } from '@harneeslab/workflows/store';
import { configureIsolation, getIsolationProvider } from '@harneeslab/isolation';
import { createLogger, getArchonHome } from '@harneeslab/paths';
import { createWorkflowDeps } from '@harneeslab/core/workflows/store-adapter';
import { discoverWorkflowsWithConfig } from '@harneeslab/workflows/workflow-discovery';
import { resolveWorkflowName } from '@harneeslab/workflows/router';
import { executeWorkflow } from '@harneeslab/workflows/executor';
import {
  getWorkflowEventEmitter,
  type WorkflowEmitterEvent,
} from '@harneeslab/workflows/event-emitter';
import type { WorkflowLoadResult } from '@harneeslab/workflows/schemas/workflow';
import type { WorkflowRun } from '@harneeslab/workflows/schemas/workflow-run';
import {
  approveWorkflow,
  rejectWorkflow,
  resumeWorkflow as resumeWorkflowOp,
  abandonWorkflow,
  getWorkflowStatus,
} from '@harneeslab/core/operations/workflow-operations';
import * as conversationDb from '@harneeslab/core/db/conversations';
import * as codebaseDb from '@harneeslab/core/db/codebases';
import * as isolationDb from '@harneeslab/core/db/isolation-environments';
import * as messageDb from '@harneeslab/core/db/messages';
import * as workflowDb from '@harneeslab/core/db/workflows';
import * as workflowEventsDb from '@harneeslab/core/db/workflow-events';
import type { WorkflowEventRow } from '@harneeslab/core/db/workflow-events';
import * as git from '@harneeslab/git';
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
      process.stderr.write(`[${event.nodeName}] 시작\n`);
      break;
    case 'node_completed':
      process.stderr.write(`[${event.nodeName}] 완료 (${formatDuration(event.duration)})\n`);
      break;
    case 'node_failed':
      process.stderr.write(`[${event.nodeName}] 실패: ${event.error}\n`);
      break;
    case 'node_skipped':
      process.stderr.write(`[${event.nodeName}] 건너뜀 (${event.reason})\n`);
      break;
    case 'approval_pending':
      process.stderr.write(`[${event.nodeId}] 승인 대기: ${event.message}\n`);
      break;
    case 'tool_started':
      if (verbose) {
        process.stderr.write(`[${event.stepName}] tool: ${event.toolName} (시작)\n`);
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
      `workflow 로드 오류: ${err.message}\n힌트: .archon/workflows/ 디렉터리 권한을 확인하세요.`
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

  console.log(`workflow(워크플로)를 찾는 중: ${cwd}`);

  if (workflowEntries.length === 0 && errors.length === 0) {
    console.log('\nworkflow(워크플로)를 찾지 못했습니다.');
    console.log('workflow 파일은 .archon/workflows/ 디렉터리에 있어야 합니다.');
    return;
  }

  if (workflowEntries.length > 0) {
    console.log(`\n${workflowEntries.length}개 workflow(워크플로)를 찾았습니다:\n`);

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
    console.log(`\n${errors.length}개 workflow(워크플로)를 로드하지 못했습니다:\n`);
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
    throw new Error('.archon/workflows/에서 workflow를 찾지 못했습니다.');
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
        `Workflow '${workflowName}' 로드 실패: ${loadError.error}\n\nYAML 파일을 수정한 뒤 다시 시도하세요.`
      );
    }
    const availableWorkflows = workflows.map(w => `  - ${w.name}`).join('\n');
    throw new Error(
      `Workflow '${workflowName}'을(를) 찾지 못했습니다.\n\n사용 가능한 workflow:\n${availableWorkflows}`
    );
  }

  // Validate mutually exclusive flags (defensive — cli.ts checks these for UX, but
  // workflowRunCommand is the authoritative boundary for programmatic callers)
  if (options.branchName !== undefined && options.noWorktree) {
    throw new Error(
      '--branch와 --no-worktree는 함께 사용할 수 없습니다.\n' +
        '  --branch는 격리된 worktree를 만듭니다.\n' +
        '  --no-worktree는 현재 repo에서 직접 실행합니다.\n' +
        '둘 중 하나만 사용하세요.'
    );
  }
  if (options.noWorktree && options.fromBranch !== undefined) {
    throw new Error(
      '--from/--from-branch는 --no-worktree와 함께 사용할 수 없습니다.\n' +
        '--from을 제거하거나 --no-worktree를 빼세요.'
    );
  }
  if (options.resume && options.branchName !== undefined) {
    throw new Error(
      '--resume과 --branch는 함께 사용할 수 없습니다.\n' +
        '  --resume은 실패한 run의 기존 worktree를 재사용합니다.\n' +
        '  --resume을 사용할 때는 --branch를 제거하세요.'
    );
  }

  console.log(`Workflow 실행: ${workflowName}`);
  console.log(`작업 디렉터리: ${cwd}`);
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
      `데이터베이스 접근 실패: ${err.message}\n힌트: DATABASE_URL 설정과 데이터베이스 실행 상태를 확인하세요.`
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
          '재개할 수 없습니다: 데이터베이스 조회에 실패했습니다.\n' +
            `오류: ${codebaseLookupError.message}\n` +
            '힌트: --resume을 사용하기 전에 데이터베이스 연결을 확인하세요.'
        );
      }
      throw new Error(
        '재개할 수 없습니다: git repository 안이 아닙니다.\n' +
          'git repo에서 실행하거나 먼저 /clone을 사용하세요.'
      );
    }

    const resumable = await workflowDb.findResumableRun(workflowName, cwd);

    if (!resumable) {
      throw new Error(
        `경로 '${cwd}'에서 workflow '${workflowName}'의 재개 가능한 run을 찾지 못했습니다.`
      );
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
          `재개할 수 없습니다: run에 기록된 작업 경로가 더 이상 없습니다: ${resumable.working_path}\n` +
            'worktree가 정리되었을 수 있습니다. 대신 --branch로 새 run을 시작하세요.'
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

    console.log(`Workflow run 재개: ${resumable.id}`);
    console.log(`작업 경로: ${workingCwd}`);
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
          `경고: 기존 worktree를 재사용합니다: ${existingEnv.working_path}. ` +
            `--from ${options.fromBranch}는 적용되지 않았습니다 (worktree가 이미 있음).`
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
            `경고: Worktree '${existingEnv.branch_name}'의 기준 branch가 '${configuredBase}'가 아닙니다. ` +
              `다음 명령으로 다시 만드세요: bun run cli complete ${existingEnv.branch_name} --force`
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
        'worktree를 만들 수 없습니다: 데이터베이스 조회에 실패했습니다.\n' +
          `오류: ${codebaseLookupError.message}\n` +
          '힌트: 데이터베이스 연결을 확인하거나 --no-worktree로 격리를 건너뛰세요.'
      );
    }
    throw new Error(
      'worktree를 만들 수 없습니다: git repository 안이 아닙니다.\n' +
        'git repo 안에서 실행하거나 --no-worktree로 격리를 건너뛰세요.'
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
    throw new Error(`conversation 업데이트 실패: ${err.message}`);
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
    console.log('\nWorkflow가 일시 중지되었습니다 - 승인을 기다리는 중입니다.');
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
    console.log('\nWorkflow가 성공적으로 완료되었습니다.');
  } else {
    throw new Error(`Workflow 실패: ${result.error}`);
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
  if (Number.isNaN(date.getTime())) return '알 수 없음';
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
          error: typeof event.data.error === 'string' ? event.data.error : '알 수 없는 오류',
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
    throw new Error(`workflow run 목록 조회 실패: ${err.message}`);
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
    console.log('실행 중인 workflow가 없습니다.');
    return;
  }

  console.log(`\n실행 중인 workflow (${runs.length}개):\n`);
  for (const run of runs) {
    const age = formatAge(run.started_at);
    console.log(`  ID:     ${run.id}`);
    console.log(`  이름:   ${run.workflow_name}`);
    console.log(`  경로:   ${run.working_path ?? '(없음)'}`);
    console.log(`  상태:   ${run.status}`);
    console.log(`  경과:   ${age}`);

    if (verbose) {
      let events: WorkflowEventRow[];
      try {
        events = await workflowEventsDb.listWorkflowEvents(run.id);
      } catch {
        events = [];
      }
      const nodes = buildNodeSummaries(events);
      if (nodes.length > 0) {
        console.log('  노드:');
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
          const stateLabel = node.state === 'running' ? ' (실행 중)' : '';
          console.log(`    ${icon} ${node.nodeId}${duration}${stateLabel}`);
          if (node.outputPreview !== undefined) {
            console.log(`        출력: ${node.outputPreview}`);
          }
          if (node.error !== undefined) {
            console.log(`        오류:  ${node.error}`);
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
      `Workflow run '${runId}'에 기록된 작업 경로가 없습니다.\n` +
        '어디서 재개해야 할지 알 수 없습니다. run이 너무 오래되었을 수 있습니다.'
    );
  }
  console.log(`Workflow 재개: ${run.workflow_name}`);
  console.log(`경로: ${run.working_path}`);
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
    throw new Error(`Workflow '${run.workflow_name}' 재개 실패: ${err.message}`);
  }
}

/**
 * Abandon a workflow run by ID (marks it as cancelled).
 */
export async function workflowAbandonCommand(runId: string): Promise<void> {
  const run = await abandonWorkflow(runId);
  console.log(`Workflow run 중단: ${runId}`);
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
      `Workflow run '${runId}'에 기록된 작업 경로가 없습니다.\n` +
        '어디서 재개해야 할지 알 수 없습니다.'
    );
  }
  console.log(`Workflow 승인: ${result.workflowName}`);
  console.log(`경로: ${result.workingPath}`);
  console.log('');
  console.log('Workflow 재개 중...');

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
      `승인은 기록했지만 workflow '${result.workflowName}' 재개에 실패했습니다: ${err.message}\n` +
        `승인은 기록되었습니다. 다시 시도하려면 'bun run cli workflow resume ${runId}'를 실행하세요.`
    );
  }
}

/**
 * Reject a paused workflow run by ID (marks it as cancelled).
 */
export async function workflowRejectCommand(runId: string, reason?: string): Promise<void> {
  const result = await rejectWorkflow(runId, reason);

  if (result.cancelled) {
    const suffix = result.maxAttemptsReached ? ' (최대 시도 횟수 도달)' : '';
    console.log(`거부 후 취소${suffix}: ${result.workflowName}`);
    return;
  }

  // Not cancelled = has onRejectPrompt, CLI auto-resumes with rejection feedback
  if (!result.workingPath) {
    throw new Error(
      `Workflow run '${runId}'에 기록된 작업 경로가 없습니다.\n` +
        '어디서 재개해야 할지 알 수 없습니다.'
    );
  }
  console.log(`Workflow 거부: ${result.workflowName}`);
  console.log('on_reject prompt로 재개 중...');

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
      `거부는 기록했지만 workflow '${result.workflowName}' 재개에 실패했습니다: ${err.message}\n` +
        `거부는 기록되었습니다. 다시 시도하려면 'bun run cli workflow resume ${runId}'를 실행하세요.`
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
      console.log(`${days}일보다 오래되어 정리할 workflow run이 없습니다.`);
    } else {
      console.log(`${days}일보다 오래된 workflow run ${count}개를 삭제했습니다.`);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days }, 'cli.workflow_cleanup_failed');
    throw new Error(`workflow run 정리 실패: ${err.message}`);
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
  console.log(`event 제출됨(최선 시도): ${eventType} for run ${runId}`);
}
