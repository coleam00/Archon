import { executeWorkflow, hydrateResumableRun, resolveContinuationWorkflow } from './executor';
import type { ExecuteWorkflowOptions } from './executor';
import {
  FRESH_RUN_FORBIDDEN_OPTIONS,
  RESUME_FORBIDDEN_OPTIONS,
  type IWorkflowEngine,
  type WorkflowEngineSubmitInput,
  type WorkflowResumeInput,
  type WorkflowResumeAdmission,
} from './engine-port';
import type { WorkflowDeps } from './deps';
import type { WorkflowExecutionResult } from './schemas';
import { TerminalStatusWriteError, requireTerminalStatusWrite } from './terminal-status-write';

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
  constructor(private readonly deps: WorkflowDeps) {}

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
      input.conversationDbId,
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

    const settled = executeWorkflow(
      this.deps,
      input.platform,
      input.conversationId,
      input.cwd,
      workflow,
      input.userMessage,
      input.conversationDbId,
      { ...input.options, ...hydrated }
    ).catch(async (error: unknown) => {
      // Hydration already claimed the row. The executor's early setup can throw
      // before its terminal-write boundary; recovery must work without a server.
      if (
        !(error instanceof TerminalStatusWriteError) &&
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
}
