import { randomUUID } from 'node:crypto';
import { IsolationBlockedError, recordWorktreeAdoption } from '@archon/isolation';
import * as sqlIsolation from '@archon/core/db/isolation-environments';
import { requireTerminalStatusWrite } from '@archon/workflows/terminal-status-write';
import type { ResolvedWorkflow } from '@archon/workflows/schemas/workflow';
import type { OwnedWorktree, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import * as db from '../../db/conversations';
import { toError } from '../../utils/error';
import { createWorkflowDeps } from '../../workflows/store-adapter';
import { createRunWorktreeSetupExecutor } from '../../workflows/worktree-setup';
import { getLog } from '../agent-log';
import { validateAndResolveIsolation } from './isolation-resolver';
import type {
  AdoptedEnvironment,
  AdoptionLane,
  DispatchScope,
  PreparedAiConfiguration,
} from './scope';

export interface ForegroundIsolation {
  cwd: string;
  cutFromCommit: string | undefined;
  ownedWorktree: OwnedWorktree | undefined;
}

export interface ForegroundIsolationInput {
  workflow: ResolvedWorkflow;
  willContinueExistingRun: boolean;
  resumableRun: WorkflowRun | null;
  adoptedEnvironment: AdoptedEnvironment | undefined;
  adoptionLane: AdoptionLane | undefined;
  setupDeps: ReturnType<typeof createWorkflowDeps>;
  setupRun: WorkflowRun | undefined;
  preparedAiConfiguration: PreparedAiConfiguration | undefined;
}

/**
 * Validate and resolve isolation; `undefined` when isolation is blocked.
 * A workflow with `worktree.enabled: false` short-circuits the resolver entirely
 * and runs in the live checkout — no worktree creation, no env row. This is the
 * declarative equivalent of CLI `--no-worktree` for workflows that should always
 * run live (e.g. read-only triage, docs generation on the main checkout).
 */
export async function resolveForegroundIsolation(
  scope: DispatchScope,
  input: ForegroundIsolationInput
): Promise<ForegroundIsolation | undefined> {
  const { conversationId, codebase } = scope;
  const { workflow, willContinueExistingRun, resumableRun, adoptedEnvironment } = input;
  const live = { cutFromCommit: undefined, ownedWorktree: undefined };
  if (willContinueExistingRun && resumableRun?.working_path) {
    const cwd = resumableRun.working_path;
    const env = await sqlIsolation.findLatestByCodebaseAndWorkingPath(codebase.id, cwd, new Date());
    if (env?.status === 'active')
      await recordWorktreeAdoption(sqlIsolation, env, codebase.default_cwd);
    return { cwd, ...live };
  }
  if (adoptedEnvironment)
    return { cwd: await runInAdoptedWorktree(scope, adoptedEnvironment), ...live };
  if (workflow.worktree?.enabled === false) {
    getLog().info(
      { workflowName: workflow.name, conversationId, codebaseId: codebase.id },
      'workflow.worktree_disabled_by_policy'
    );
    return { cwd: codebase.default_cwd, ...live };
  }
  return resolveNewIsolation(scope, input);
}

/**
 * Adoption lane: the adopted run's worktree survives — run in it dirty-as-is
 * instead of cutting a fresh one (same shape as the background dispatch in
 * ./background.ts). Linking the env keeps isolation hygiene pointed at this
 * checkout.
 */
async function runInAdoptedWorktree(
  { conversation, conversationId }: DispatchScope,
  adoptedEnvironment: AdoptedEnvironment
): Promise<string> {
  const cwd = adoptedEnvironment.working_path;
  await db
    .updateConversation(conversation.id, {
      cwd,
      isolation_env_id: adoptedEnvironment.id,
    })
    .catch((e: unknown) => {
      getLog().warn({ err: toError(e), conversationId }, 'orchestrator.worker_cwd_persist_failed');
    });
  return cwd;
}

async function resolveNewIsolation(
  scope: DispatchScope,
  { workflow, adoptionLane, setupDeps, setupRun, preparedAiConfiguration }: ForegroundIsolationInput
): Promise<ForegroundIsolation | undefined> {
  const { platform, conversationId, conversation, codebase, isolationHints, userId } = scope;
  try {
    const result = await validateAndResolveIsolation(
      // A checkout-branch adoption must not adopt the conversation's existing env:
      // the resolver short-circuits on `existingEnvId` before hints are read (R7), so a
      // stale worktree from an earlier run in this conversation would win over the
      // adopted branch. Null it out — same shape the `stale_cleaned` retry sees.
      {
        ...conversation,
        codebase_id: codebase.id,
        ...(adoptionLane?.kind === 'checkout-branch' ? { isolation_env_id: null } : {}),
      },
      codebase,
      platform,
      conversationId,
      adoptionLane?.kind === 'checkout-branch'
        ? {
            ...isolationHints,
            // Unique per dispatch: a shared id would key the reuse lookup to an
            // earlier adoption's worktree and drop the exact branch on later ones.
            workflowId: randomUUID(),
            workflowType: 'task',
            taskBranch: adoptionLane.taskBranch,
          }
        : isolationHints,
      false,
      userId,
      setupRun && preparedAiConfiguration
        ? createRunWorktreeSetupExecutor(setupDeps, setupRun, preparedAiConfiguration.config)
        : undefined
    );
    return result.status === 'new'
      ? {
          cwd: result.cwd,
          cutFromCommit: result.cutFromCommit,
          ownedWorktree: result.ownedWorktree,
        }
      : { cwd: result.cwd, cutFromCommit: undefined, ownedWorktree: undefined };
  } catch (error) {
    if (!(error instanceof IsolationBlockedError)) throw error;
    if (setupRun)
      await requireTerminalStatusWrite(
        setupDeps.store.failWorkflowRun(setupRun.id, error.message, {
          exitReason: 'launch_failed',
        }),
        { workflowRunId: setupRun.id, site: 'foreground.worktree_setup_failed' }
      );
    getLog().warn(
      {
        reason: error.reason,
        conversationId,
        codebaseId: codebase.id,
        workflowName: workflow.name,
      },
      'isolation_blocked'
    );
    return undefined;
  }
}
