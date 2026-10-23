// The detached half of a background dispatch: submit the run to the engine, then report
// its outcome to the parent conversation. Nothing here throws to the dispatcher.
import { createLogger } from '@archon/paths';
import type { InProcessWorkflowEngine } from '@archon/workflows/in-process-engine';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { OwnedWorktree } from '@archon/workflows/schemas/workflow-run';
import type { PreparedWorkflowSource } from '@archon/workflows/run-source';
import type { PreparedRunAiConfiguration } from '@archon/workflows/run-preflight';
import type { Conversation } from '../../types';
import { toError } from '../../utils/error';
import type { createWorkflowDeps } from '../../workflows/store-adapter';
import type { createCodebaseChildResolver } from '../../workflows/child-isolation-resolver';
import type { WorkflowRoutingContext } from './background';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}

type WorkflowDeps = ReturnType<typeof createWorkflowDeps>;
type SubmitResult = Awaited<ReturnType<InProcessWorkflowEngine['submit']>>;

export interface WorkerCheckout {
  cwd: string;
  cutFromCommit?: string;
  ownedWorktree?: OwnedWorktree;
  baseBranch?: string;
  resolveChildIsolation?: ReturnType<typeof createCodebaseChildResolver>;
}

export interface BackgroundRun {
  ctx: WorkflowRoutingContext;
  workflow: ResolvedWorkflow;
  workflowDeps: WorkflowDeps;
  engine: InProcessWorkflowEngine;
  workerPlatformId: string;
  workerConv: Conversation;
  preCreatedRun: Awaited<ReturnType<WorkflowDeps['store']['createWorkflowRun']>>;
  preparedSource: PreparedWorkflowSource;
  preparedAiConfiguration: PreparedRunAiConfiguration;
  checkout: WorkerCheckout;
  isolationContext?: {
    branchName?: string;
    isPrReview?: boolean;
    prSha?: string;
    prBranch?: string;
  };
  closeRunLiveOwner: () => Promise<void>;
}

/** Run the workflow in the worker conversation; resolves once it settles and is reported. */
export async function runInBackground(run: BackgroundRun): Promise<void> {
  const { ctx, workerPlatformId, workerConv } = run;
  let finalizeConversation: (() => Promise<void>) | undefined;
  try {
    try {
      finalizeConversation = await ctx.platform.prepareBackgroundConversation?.({
        workerConversationId: workerPlatformId,
        parentConversationId: ctx.conversationId,
        conversationDbId: workerConv.id,
      });
      const result = await submitRun(run);
      await run.closeRunLiveOwner();
      await surfaceResult(run, result);
    } catch (error) {
      await reportFailure(run, error);
    } finally {
      await finalizeConversation?.();
    }
  } catch (outerError) {
    getLog().error({ err: toError(outerError) }, 'background_workflow_unhandled_error');
  } finally {
    await run.closeRunLiveOwner();
  }
}

function submitRun(run: BackgroundRun): Promise<SubmitResult> {
  const { ctx, workflow, checkout } = run;
  return run.engine.submit({
    platform: ctx.platform,
    conversationId: run.workerPlatformId,
    cwd: checkout.cwd,
    workflow,
    userMessage: ctx.originalMessage,
    origin: {
      conversationId: run.workerConv.id,
      parentConversationId: ctx.conversationDbId,
      userId: ctx.userId,
    },
    options: {
      codebaseId: ctx.codebaseId,
      issueContext: ctx.issueContext,
      isolationContext: run.isolationContext,
      preCreatedRun: run.preCreatedRun,
      source: ctx.source,
      parseWarnings: ctx.parseWarnings,
      baseBranch: checkout.baseBranch,
      resolveChildIsolation: checkout.resolveChildIsolation,
      preparedSource: run.preparedSource,
      preparedAiConfiguration: run.preparedAiConfiguration,
      ...(checkout.cutFromCommit !== undefined ? { cutFromCommit: checkout.cutFromCommit } : {}),
      ownedWorktree: checkout.ownedWorktree,
      inputs: ctx.inputs,
      ...(ctx.adoptRunId
        ? { adoptedFromRunId: ctx.adoptRunId, continuationMode: 'adopt' as const }
        : ctx.supersedesRunId
          ? {
              adoptedFromRunId: ctx.supersedesRunId,
              continuationMode: 'supersede' as const,
            }
          : {}),
      ...(ctx.modelOverrides
        ? { modelOverrideLayer: { kind: 'raw' as const, overrides: ctx.modelOverrides } }
        : {}),
      ...(ctx.runConfig ? { runConfig: ctx.runConfig } : {}),
    },
  });
}

/** Surface workflow output to parent conversation as a result card */
async function surfaceResult(run: BackgroundRun, result: SubmitResult): Promise<void> {
  const { ctx, workflow } = run;
  let card: { message: string; runId: string };
  if ('summary' in result && result.summary) {
    card = { message: result.summary, runId: result.workflowRunId };
  } else if (!result.success && result.workflowRunId) {
    // Surface failure as a result card so the chat shows status + "View full logs"
    card = {
      message: `Workflow **${workflow.name}** failed: ${result.error}`,
      runId: result.workflowRunId,
    };
  } else {
    return;
  }
  try {
    await ctx.platform.sendMessage(ctx.conversationId, card.message, {
      category: 'workflow_result',
      segment: 'new',
      workflowResult: {
        workflowName: workflow.name,
        runId: card.runId,
      },
    });
  } catch (surfaceError) {
    getLog().warn(
      { err: toError(surfaceError), conversationId: ctx.conversationId },
      'workflow_output_surface_failed'
    );
  }
}

async function reportFailure(run: BackgroundRun, error: unknown): Promise<void> {
  const { ctx, workflow, preCreatedRun } = run;
  const err = toError(error);
  const terminalWriteFailed = error instanceof TerminalStatusWriteError;
  // A rejected terminal write leaves the row saying `running`. Do not compensate
  // with a second failWorkflowRun over the write channel that just failed, and do
  // not tell the user the workflow "failed" — its real outcome is unknown.
  if (!terminalWriteFailed) {
    await run.workflowDeps.store
      .failWorkflowRun(preCreatedRun.id, err.message, { exitReason: 'unhandled_error' })
      .catch(dbError => {
        getLog().error(
          { err: toError(dbError), workflowRunId: preCreatedRun.id },
          'background_workflow_fail_db_record_failed'
        );
      });
  }
  getLog().error(
    {
      err,
      workflowName: workflow.name,
      workerConversationId: run.workerPlatformId,
    },
    terminalWriteFailed ? 'background_workflow_terminal_write_failed' : 'background_workflow_failed'
  );
  await run.closeRunLiveOwner();
  // Surface error to parent conversation — include workflowResult metadata when
  // we have a pre-created run ID so the chat renders a result card with "View full logs"
  const failureRunId = preCreatedRun.id;
  const failureMessage = terminalWriteFailed
    ? `⚠️ Workflow **${workflow.name}** finished, but its final status could not be saved. ` +
      'It may still show as running — check it before starting another.'
    : `Workflow **${workflow.name}** failed: ${err.message}`;
  await ctx.platform
    .sendMessage(
      ctx.conversationId,
      failureMessage,
      failureRunId
        ? {
            category: 'workflow_result',
            segment: 'new',
            workflowResult: { workflowName: workflow.name, runId: failureRunId },
          }
        : undefined
    )
    .catch((sendErr: unknown) => {
      getLog().error({ err: toError(sendErr) }, 'background_workflow_notify_failed');
    });
}
