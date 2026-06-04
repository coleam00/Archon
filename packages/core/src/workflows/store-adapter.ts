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
import * as workflowNodeSessionDb from '../db/workflow-node-sessions';
import * as codebaseDb from '../db/codebases';
import * as envVarDb from '../db/env-vars';
import { getAgentProvider } from '@archon/providers';
import { loadConfig as loadMergedConfig } from '../config/config-loader';
import { createLogger } from '@archon/paths';
import type { IGitHubAppAuthProvider } from '../github-auth';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { getDecryptedAccessToken } from '../db/user-github-token-store';

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
    getWorkflowNodeSession: workflowNodeSessionDb.getWorkflowNodeSession,
    upsertWorkflowNodeSession: workflowNodeSessionDb.upsertWorkflowNodeSession,
    deleteWorkflowNodeSessions: workflowNodeSessionDb.deleteWorkflowNodeSessions,
  };
}

/**
 * Module-singleton registration for the GitHub App auth provider. Set by the
 * server bootstrap (`registerGitHubAppAuthProvider(provider)`) when App mode
 * is active; remains null in PAT mode and during CLI execution. The
 * workflow-deps factory reads this to decide whether to expose
 * `resolveBotGitHubToken` to the engine.
 *
 * Singleton because the provider is itself a process-singleton (one cache
 * shared by the GitHub adapter, the workflow executor, and the internal
 * credential-helper endpoint). Threading it through every createWorkflowDeps
 * caller would just smuggle a singleton through more arguments.
 */
let registeredGitHubAppAuthProvider: IGitHubAppAuthProvider | null = null;

export function registerGitHubAppAuthProvider(provider: IGitHubAppAuthProvider | null): void {
  registeredGitHubAppAuthProvider = provider;
}

/**
 * Create the canonical WorkflowDeps for the workflow engine.
 * Single construction point — avoids duplicating the wiring across callers.
 */
export function createWorkflowDeps(): WorkflowDeps {
  const provider = registeredGitHubAppAuthProvider;
  return {
    store: createWorkflowStore(),
    getAgentProvider,
    loadConfig: loadMergedConfig,
    // App mode: resolve fresh installation tokens for subprocess env. PAT mode:
    // undefined → engine falls back to env inheritance, preserving legacy
    // behaviour for solo installs.
    resolveBotGitHubToken: provider
      ? async (owner: string, repo: string): Promise<string | undefined> => {
          try {
            return await provider.getInstallationToken(owner, repo);
          } catch (err) {
            getLog().warn(
              { err: err as Error, owner, repo },
              'workflow_deps.bot_token_resolve_failed'
            );
            return undefined;
          }
        }
      : undefined,
    // Per-user token policy (PR-C): when per-user mode is on, route a run's
    // gh/git through the originating user's personal token (decrypted, refreshed
    // on read), or scrub the org/bot token when they haven't connected.
    isPerUserGitHubEnabled: () => isPerUserGitHubEnabled(),
    getUserGithubToken: async (userId: string): Promise<string | undefined> => {
      try {
        return (await getDecryptedAccessToken(userId)) ?? undefined;
      } catch (err) {
        getLog().warn({ err: err as Error, userId }, 'workflow_deps.user_token_resolve_failed');
        return undefined;
      }
    },
  };
}
