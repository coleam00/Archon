import { isWorkflowExecutionInterruption } from './execution-interruption';
import { executeWorkflow, type ExecuteWorkflowOptions } from './executor';
import { hydrateResumableRun } from './run-resume';
import { resolveContinuationWorkflow } from './run-source';
import {
  WorkflowExecutionHandoffError,
  FRESH_RUN_FORBIDDEN_OPTIONS,
  RESUME_FORBIDDEN_OPTIONS,
  type AttentionWatch,
  type AttentionWatchOptions,
  type IWorkflowEngine,
  type WorkflowEngineSubmitInput,
  type WorkflowResumeInput,
  type WorkflowResumeAdmission,
  type WorkflowRunDelivery,
  type WorkflowRunSubscription,
  type WorkflowRunSubscriptionOptions,
} from './engine-port';
import { subscribeToRunTree } from './run-subscription';
import {
  watchAttentionQueue,
  type AttentionStreamLine,
  type AttentionWatchHost,
} from './attention-watch';
import type { WorkflowDeps } from './deps';
import type { WorkflowExecutionResult } from './schemas';
import { requireTerminalStatusWrite } from './terminal-status-write';
import { resolveRunExecutionMode } from './container-context';

function rejectOptions(
  options: ExecuteWorkflowOptions | undefined,
  forbidden: readonly (keyof ExecuteWorkflowOptions)[],
  operation: 'submit' | 'resume'
): void {
  for (const field of forbidden) {
    if (options?.[field] !== undefined) {
      throw new Error(`Cannot supply '${field}' to workflow engine ${operation}.`);
    }
  }
}

export class InProcessWorkflowEngine implements IWorkflowEngine {
  /** `attention` is the host's side of `watchAttention`; engines built without it refuse to watch. */
  constructor(
    private readonly deps: WorkflowDeps,
    private readonly attention?: AttentionWatchHost
  ) {}

  async submit(input: WorkflowEngineSubmitInput): Promise<WorkflowExecutionResult> {
    rejectOptions(input.options, FRESH_RUN_FORBIDDEN_OPTIONS, 'submit');
    if (input.options?.preCreatedRun && input.options.preCreatedRun.status !== 'pending') {
      throw new Error('Fresh execution requires a pending pre-created run; use resume instead.');
    }
    return executeWorkflow(
      this.deps,
      input.platform,
      input.conversationId,
      input.cwd,
      input.workflow,
      input.userMessage,
      input.origin,
      input.options
    );
  }

  async resume(input: WorkflowResumeInput): Promise<WorkflowResumeAdmission> {
    rejectOptions(input.options, RESUME_FORBIDDEN_OPTIONS, 'resume');
    const continuation = await resolveContinuationWorkflow(this.deps, input.run, input.cwd);
    let workflow = continuation?.workflow;
    if (!workflow) {
      if (!input.legacyWorkflow) {
        throw new Error(
          `Workflow run '${input.run.id}' has no captured source; supply its legacy workflow fallback.`
        );
      }
      if (input.legacyWorkflow.name !== input.run.workflow_name) {
        throw new Error(
          `Legacy workflow fallback '${input.legacyWorkflow.name}' does not match run workflow '${input.run.workflow_name}'.`
        );
      }
      workflow = input.legacyWorkflow;
    }
    const hydrated = await hydrateResumableRun(this.deps, input.run, input.cursor);
    if (hydrated === null) return { accepted: false, reason: 'nothing-to-resume' };

    let context: Pick<WorkflowResumeInput, 'cwd' | 'options'> = input;
    if (input.prepareExecution) {
      try {
        context = await input.prepareExecution(structuredClone(hydrated.preCreatedRun));
        rejectOptions(context.options, RESUME_FORBIDDEN_OPTIONS, 'resume');
        resolveRunExecutionMode(
          context.options?.execContext,
          context.options?.container,
          hydrated.preCreatedRun.metadata
        );
      } catch (error) {
        await requireTerminalStatusWrite(
          this.deps.store.failWorkflowRun(
            hydrated.preCreatedRun.id,
            error instanceof Error ? error.message : String(error)
          ),
          { workflowRunId: hydrated.preCreatedRun.id, site: 'engine.resume_preparation_failed' }
        );
        throw error;
      }
    }

    const settled = executeWorkflow(
      this.deps,
      input.platform,
      input.conversationId,
      context.cwd,
      workflow,
      input.userMessage,
      hydrated.preCreatedRun.origin ?? undefined,
      { ...context.options, ...hydrated }
    ).catch(async (error: unknown) => {
      // Hydration already claimed the row. The executor's early setup can throw
      // before its terminal-write boundary; recovery must work without a server.
      if (
        !isWorkflowExecutionInterruption(error) &&
        !(error instanceof WorkflowExecutionHandoffError) &&
        (await this.deps.store.getWorkflowRunStatus(hydrated.preCreatedRun.id)) === 'running'
      ) {
        await requireTerminalStatusWrite(
          this.deps.store.failWorkflowRun(
            hydrated.preCreatedRun.id,
            error instanceof Error ? error.message : String(error)
          ),
          { workflowRunId: hydrated.preCreatedRun.id, site: 'engine.resume_execution_failed' }
        );
      }
      throw error;
    });
    return { accepted: true, runId: hydrated.preCreatedRun.id, settled };
  }

  subscribe(
    runId: string,
    listener: (delivery: WorkflowRunDelivery) => void,
    options?: WorkflowRunSubscriptionOptions
  ): Promise<WorkflowRunSubscription> {
    return subscribeToRunTree(this.deps.store, runId, listener, options);
  }

  watchAttention(
    listener: (line: AttentionStreamLine) => void | Promise<void>,
    options: AttentionWatchOptions
  ): Promise<AttentionWatch> {
    if (this.attention === undefined)
      return Promise.reject(new Error('This engine was built without an attention-watch host.'));
    return watchAttentionQueue(this.deps.store, this.attention, listener, options);
  }
}
