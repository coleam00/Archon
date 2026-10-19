/** What a run records and tells the user as it starts, once its paths and source are ready. */
import * as archonPaths from '@archon/paths';
import { captureWorkflowInvoked, createLogger } from '@archon/paths';
import { formatDeprecationNotice } from './deprecation';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import { getWorkflowEventEmitter } from './event-emitter';
import type { ExecuteWorkflowOptions } from './executor';
import { logWorkflowResume, logWorkflowStart } from './logger';
import { sendCriticalMessage, type SendMessageContext } from './platform-messages';
import type { RunDispatch } from './run-dispatch';
import {
  isExecNode,
  isGateNode,
  isLoopGroupNode,
  isLoopNode,
  runMayPersistSessions,
  type ResolvedWorkflow,
  type WorkflowRun,
} from './schemas';
import { workflowTelemetryShape } from './telemetry-shape';

/** Lazy-initialized logger, under the executor name these events have always carried. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.executor');
  return cachedLog;
}

/**
 * Log, register and announce the run: the log file, the live `workflow_started` event,
 * anonymous telemetry, the durable start events, and the user's startup message.
 */
export async function announceRunStart(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  userMessage: string,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch,
  paths: { logDir: string; outputRoot: string }
): Promise<void> {
  const { issueContext } = opts;
  getLog().info(
    {
      workflowName: workflow.name,
      workflowRunId: workflowRun.id,
      hasIssueContext: !!issueContext,
      issueContextLength: issueContext?.length ?? 0,
    },
    'workflow_starting'
  );
  // `isContinuation`, not `priorCompletedNodes`: a failed child re-entered without a
  // resumable snapshot is still a resume of an existing run.
  if (dispatch.isContinuation) {
    await logWorkflowResume(paths.logDir, workflowRun.id, workflow.name);
  } else {
    await logWorkflowStart(paths.logDir, workflowRun.id, workflow.name, userMessage);
  }

  // Register run with emitter and emit workflow_started
  const emitter = getWorkflowEventEmitter();
  emitter.registerRun(workflowRun.id, conversationId);

  const transcriptPath = archonPaths.getRunLogPathForRoot(paths.outputRoot, workflowRun.id);
  emitter.emit({
    type: 'workflow_started',
    runId: workflowRun.id,
    workflowName: workflow.name,
    conversationId: workflowRun.conversation_id,
    transcriptPath,
  });

  captureRunTelemetry(deps, platform, workflow, workflowRun, opts, dispatch);
  recordStartEvents(deps, platform, workflow, workflowRun, opts, dispatch, transcriptPath);
  await sendStartupMessage(platform, conversationId, cwd, workflow, workflowRun, opts);
}

/**
 * Fire-and-forget anonymous usage telemetry. Categorical only: bundled
 * workflows report their real name, custom ones report "custom". No PII —
 * descriptions/prompts/paths are never sent. Machine context + version ride
 * along as super-properties. Opt out: ARCHON_TELEMETRY_DISABLED=1 / DO_NOT_TRACK=1.
 */
function captureRunTelemetry(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch
): void {
  const { runSource } = dispatch;
  const telemetryNodes = workflow.nodes;
  captureWorkflowInvoked({
    runId: workflowRun.id,
    isChild: workflowRun.parent_run_id != null,
    workflowName: workflow.name,
    workflowSource: runSource,
    platform: platform.getPlatformType(),
    provider: dispatch.prepared.scope.provider,
    model: dispatch.prepared.scope.model,
    nodeCount: telemetryNodes.length,
    usesLoop: telemetryNodes.some(isLoopNode),
    usesLoopGroup: telemetryNodes.some(isLoopGroupNode),
    usesApproval: telemetryNodes.some(isGateNode),
    usesScript: telemetryNodes.some(n => isExecNode(n) && n.runtime !== 'sh'),
    usesBash: telemetryNodes.some(n => isExecNode(n) && n.runtime === 'sh'),
    usesOutputFormat: telemetryNodes.some(n => n.output_format !== undefined),
    usesOutputType: telemetryNodes.some(n => n.output_type !== undefined),
    usesPersistSession: runMayPersistSessions(workflow),
    usesMcp: telemetryNodes.some(n => n.mcp !== undefined),
    usesSkills: telemetryNodes.some(n => n.skills !== undefined),
    usesFreshContext: telemetryNodes.some(n => isLoopNode(n) && n.loop.fresh_context),
    usedIsolation: opts.isolationContext !== undefined,
    isResume: dispatch.isContinuation,
    ...workflowTelemetryShape(deps.providers, workflow, runSource),
  });
}

/** The run's durable start records. Each persists best-effort: a failed write is logged, never thrown. */
function recordStartEvents(
  deps: WorkflowDeps,
  platform: IWorkflowPlatform,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  opts: ExecuteWorkflowOptions,
  dispatch: RunDispatch,
  transcriptPath: string
): void {
  const { provider, model } = dispatch.prepared.scope;
  let isolationMode: 'container' | 'worktree' | 'in-place' = 'in-place';
  if (opts.execContext?.kind === 'container') {
    isolationMode = 'container';
  } else if (opts.isolationContext) {
    isolationMode = 'worktree';
  }

  deps.store
    .createWorkflowEvent({
      workflow_run_id: workflowRun.id,
      event_type: 'workflow_started',
      data: {
        workflowName: workflow.name,
        defaultAssistant: dispatch.prepared.baseAiProfile.defaultProvider,
        provider,
        model: model ?? null,
        isolationMode,
        baseBranch: dispatch.baseBranch,
        userId: workflowRun.user_id ?? null,
        userMessage: workflowRun.user_message,
        origin: workflowRun.parent_run_id ? 'workflow' : platform.getPlatformType(),
        transcriptPath,
      },
    })
    .catch((err: Error) => {
      getLog().error(
        { err, workflowRunId: workflowRun.id, eventType: 'workflow_started' },
        'workflow_event_persist_failed'
      );
    });

  // Keys the engine dropped from this run's YAML (#2213). Recorded here rather
  // than at the chat/console dispatch site for two reasons: every run reaches
  // this line whatever surface started it (CLI and REST included, which have no
  // conversation to post into), and the record is therefore written by a path
  // that a failed `platform.sendMessage` cannot touch. That notification stays
  // best-effort; this is the durable trace behind it, readable via
  // `archon workflow get <id> --verbose` and the events API.
  const { parseWarnings } = opts;
  if (parseWarnings && parseWarnings.length > 0) {
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'workflow_parse_warnings',
        data: {
          workflowName: workflow.name,
          warnings: [...parseWarnings],
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'workflow_parse_warnings' },
          'workflow_event_persist_failed'
        );
      });
  }

  // Deprecated bundled default (#2781). Recorded here like the parse warnings
  // above so every run surface — REST/detached starts included, which have no
  // conversation to post into — carries the removal notice on its durable trace.
  // The chat/web message that mirrors this is best-effort; this record cannot fail.
  const deprecationNotice = formatDeprecationNotice(workflow);
  if (deprecationNotice) {
    deps.store
      .createWorkflowEvent({
        workflow_run_id: workflowRun.id,
        event_type: 'workflow_deprecation_notice',
        data: {
          workflowName: workflow.name,
          notice: deprecationNotice,
        },
      })
      .catch((err: Error) => {
        getLog().error(
          { err, workflowRunId: workflowRun.id, eventType: 'workflow_deprecation_notice' },
          'workflow_event_persist_failed'
        );
      });
  }
}

async function sendStartupMessage(
  platform: IWorkflowPlatform,
  conversationId: string,
  cwd: string,
  workflow: ResolvedWorkflow,
  workflowRun: WorkflowRun,
  opts: ExecuteWorkflowOptions
): Promise<void> {
  // Context for error logging
  const workflowContext: SendMessageContext = {
    workflowId: workflowRun.id,
  };

  // Build startup message
  let startupMessage = '';

  // Add isolation context to startup message
  const { isolationContext } = opts;
  if (isolationContext) {
    const { isPrReview, prSha, prBranch, branchName } = isolationContext;

    if (isPrReview && prSha && prBranch) {
      startupMessage += `Reviewing PR at commit \`${prSha.substring(0, 7)}\` (branch: \`${prBranch}\`)\n\n`;
    } else if (branchName) {
      const repoName = cwd.split(/[/\\]/).pop() || 'repository';
      await sendCriticalMessage(
        platform,
        conversationId,
        `📍 ${repoName} @ \`${branchName}\``,
        workflowContext,
        2,
        { category: 'isolation_context', segment: 'new' }
      );
    } else {
      getLog().warn(
        {
          workflowId: workflowRun.id,
          hasFields: {
            isPrReview: !!isPrReview,
            prSha: !!prSha,
            prBranch: !!prBranch,
            branchName: !!branchName,
          },
        },
        'isolation_context_incomplete'
      );
    }
  }

  // Add workflow start message (step details omitted from text notification)
  // Strip routing metadata from description (Use when:, Handles:, NOT for:, Capability:, Triggers:)
  const cleanDescription = (workflow.description ?? '')
    .split('\n')
    .filter(
      line => !/^\s*(Use when|Handles|NOT for|Capability|Triggers)[:\s]/i.test(line) && line.trim()
    )
    .join('\n')
    .trim();
  const descriptionText = cleanDescription || workflow.name;
  startupMessage += `🚀 **Starting workflow**: \`${workflow.name}\`\n\n> ${descriptionText}`;

  // Send consolidated message - use critical send with limited retries (1 retry max)
  // to avoid blocking workflow execution while still catching transient failures
  const startupSent = await sendCriticalMessage(
    platform,
    conversationId,
    startupMessage,
    workflowContext,
    2, // maxRetries=2 means 2 total attempts (1 initial + 1 retry), 1s max delay
    { category: 'workflow_status', segment: 'new' }
  );
  if (!startupSent) {
    getLog().error(
      { workflowId: workflowRun.id, conversationId },
      'startup_message_delivery_failed'
    );
    // Continue anyway - workflow is already recorded in database
  }
}
