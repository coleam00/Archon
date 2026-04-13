/**
 * WorkflowStore adapter — bridges @archon/core DB modules to the
 * IWorkflowStore trait defined in @archon/workflows.
 */
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowConfig, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import type { MergedConfig } from '../config/config-types';
import * as workflowDb from '../db/workflows';
import * as workflowEventDb from '../db/workflow-events';
import * as codebaseDb from '../db/codebases';
import * as envVarDb from '../db/env-vars';
import { getAgentProvider } from '@archon/providers';
import { loadConfig as loadMergedConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';

// Compile-time assertion: MergedConfig must remain a structural subtype of WorkflowConfig.
// If MergedConfig drifts from WorkflowConfig, this line becomes a type error.
const assertConfigCompat: WorkflowConfig = {} as MergedConfig;
void assertConfigCompat;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.store-adapter');
  return cachedLog;
}

export function createWorkflowStore(): IWorkflowStore {
  return {
    createWorkflowRun: workflowDb.createWorkflowRun,
    getWorkflowRun: workflowDb.getWorkflowRun,
    getActiveWorkflowRunByPath: workflowDb.getActiveWorkflowRunByPath,
    findResumableRun: workflowDb.findResumableRun,
    failOrphanedRuns: workflowDb.failOrphanedRuns,
    resumeWorkflowRun: workflowDb.resumeWorkflowRun,
    updateWorkflowRun: workflowDb.updateWorkflowRun,
    updateWorkflowActivity: workflowDb.updateWorkflowActivity,
    // DB returns string | null; IWorkflowStore declares WorkflowRunStatus | null.
    // The remote_agent_workflow_runs.status column is constrained to valid enum values
    // in SQL, so this cast is safe as long as the column constraint matches WorkflowRunStatus.
    getWorkflowRunStatus: id =>
      workflowDb.getWorkflowRunStatus(id) as Promise<WorkflowRunStatus | null>,
    completeWorkflowRun: workflowDb.completeWorkflowRun,
    failWorkflowRun: workflowDb.failWorkflowRun,
    pauseWorkflowRun: workflowDb.pauseWorkflowRun,
    cancelWorkflowRun: workflowDb.cancelWorkflowRun,
    createWorkflowEvent: async (data): Promise<void> => {
      try {
        await workflowEventDb.createWorkflowEvent(data);
      } catch (err) {
        // Belt-and-suspenders: workflowEventDb.createWorkflowEvent already catches internally,
        // but this wrapper guarantees the IWorkflowStore non-throwing contract at the boundary.
        getLog().error(
          { err: err as Error, eventType: data.event_type, runId: data.workflow_run_id },
          'workflow_event_create_unexpected_throw'
        );
      }
    },
    getCompletedDagNodeOutputs: workflowEventDb.getCompletedDagNodeOutputs,
    getCodebase: codebaseDb.getCodebase,
    getCodebaseEnvVars: envVarDb.getCodebaseEnvVars,
  };
}

/**
 * Create the canonical WorkflowDeps for the workflow engine.
 * Single construction point — avoids duplicating the wiring across callers.
 */
export function createWorkflowDeps(): WorkflowDeps {
  return {
    store: createWorkflowStore(),
    getAgentProvider,
    loadConfig: loadMergedConfig,
  };
}
