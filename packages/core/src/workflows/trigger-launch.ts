import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getArchonHome, createLogger } from '@archon/paths';
import {
  admitWorkflowTrigger,
  triggerBindingsSchema,
  triggerEventSchema,
  authorizeTriggerEvent,
  type TriggerBinding,
  type TriggerAdmission,
} from '@archon/workflows/trigger';
import { triggerAttributionSchema } from '@archon/workflows/trigger';
import { executeWorkflow, resolveContinuationWorkflow } from '@archon/workflows/executor';
import { TerminalStatusWriteError } from '@archon/workflows/terminal-status-write';
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowExecutionResult } from '@archon/workflows/schemas/workflow';
import { createWorkflowDeps } from './store-adapter';
import { createWorkflowTriggerStore } from '../db/workflow-triggers';
import { getCodebase } from '../db/codebases';
import {
  getOrCreateConversation,
  getConversationById,
  updateConversation,
} from '../db/conversations';
import { createChildWorktreeResolver } from './child-isolation-resolver';
import { validateAndResolveIsolation } from '../orchestrator/orchestrator';
import { startRunLiveOwner } from '../services/run-live-owner';
import { loadConfig } from '../config/config-loader';
import { addMessage } from '../db/messages';

/** A missing file opts out. A malformed configured file fails closed. */
export async function loadTriggerBindings(): Promise<TriggerBinding[]> {
  let contents: string;
  try {
    contents = await readFile(join(getArchonHome(), 'triggers.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return triggerBindingsSchema.parse(JSON.parse(contents));
}

export interface TriggerDelivery {
  admission: TriggerAdmission;
  /** Hosts must keep this execution alive until it settles. Redeliveries have no owner. */
  completion?: Promise<WorkflowExecutionResult>;
}

/** Shared CLI/server host over engine admission, source capture and execution. */
export async function deliverWorkflowTrigger(
  binding: TriggerBinding,
  payload: unknown,
  deps: WorkflowDeps = createWorkflowDeps(),
  userId?: string
): Promise<TriggerDelivery> {
  binding = triggerBindingsSchema.parse([binding])[0];
  const event = triggerEventSchema.parse(payload);
  authorizeTriggerEvent(binding, event);
  const codebase = await getCodebase(binding.codebaseId);
  if (!codebase) throw new Error(`Trigger '${binding.id}' has an unknown project`);
  // Tuple encoding prevents separator collisions; hashing also fits the native
  // conversation identifier's database bound for maximum-length event identities.
  const conversationKey = createHash('sha256')
    .update(JSON.stringify([binding.id, event.eventId]))
    .digest('hex');
  const conversation = await getOrCreateConversation('cli', `trigger:${conversationKey}`);
  const store = createWorkflowTriggerStore();
  const admission = await admitWorkflowTrigger(deps, store, {
    binding,
    event,
    cwd: codebase.default_cwd,
    conversationId: conversation.id,
    userId,
  });
  if (admission.disposition === 'skipped') return { admission };

  // CAS, rather than a delivery-local boolean or TTL, gates the first execution.
  // Pending admission survives a crash and can be driven by a later delivery.
  const run = await store.claimPendingRun(admission.runId);
  if (!run) return { admission };
  // Record native notices for inspection without opening a conversational turn.
  const triggerPlatform: IWorkflowPlatform = {
    async sendMessage(_id, message, metadata): Promise<void> {
      await addMessage(run.conversation_id, 'assistant', message, { ...metadata });
    },
    getStreamingMode: () => 'batch',
    getPlatformType: () => 'cli',
  };
  const completion = (async (): Promise<WorkflowExecutionResult> => {
    const liveOwner = await startRunLiveOwner(run.id);
    try {
      const attribution = triggerAttributionSchema.parse(run.metadata.trigger);
      const codebase = await getCodebase(attribution.binding.codebaseId);
      if (!codebase) throw new Error('Admitted trigger project is missing');
      const recorded = await resolveContinuationWorkflow(deps, run, codebase.default_cwd);
      if (!recorded) throw new Error('Admitted trigger run has no captured source');
      const workflow = recorded.workflow;
      const config = await loadConfig(codebase.default_cwd);
      // Container startup is not part of this narrow host yet. Refuse it instead
      // of silently executing a container-declared workflow on the host.
      if (workflow.container?.enabled ?? (codebase.kind === 'folder' && config.container?.enabled))
        throw new Error('Native triggers do not yet support container startup');
      const ownerConversation = await getConversationById(run.conversation_id);
      if (!ownerConversation) throw new Error('Admitted trigger conversation is missing');
      let cwd = codebase.default_cwd;
      if (codebase.kind !== 'folder' && workflow.worktree?.enabled !== false) {
        const isolation = await validateAndResolveIsolation(
          ownerConversation,
          codebase,
          triggerPlatform,
          ownerConversation.platform_conversation_id,
          { workflowType: 'thread', workflowId: run.id }
        );
        cwd = isolation.cwd;
      }
      await updateConversation(ownerConversation.id, { cwd, codebase_id: codebase.id });
      return await executeWorkflow(
        deps,
        triggerPlatform,
        ownerConversation.platform_conversation_id,
        cwd,
        workflow,
        run.user_message ?? '',
        run.conversation_id,
        {
          preCreatedRun: run,
          codebaseId: codebase.id,
          source: attribution.binding.source,
          baseBranch: codebase.default_branch ?? config.baseBranch,
          resolveChildIsolation:
            codebase.kind === 'folder'
              ? undefined
              : createChildWorktreeResolver({
                  codebaseId: codebase.id,
                  codebaseName: codebase.name,
                  canonicalRepoPath: codebase.default_cwd,
                  baseBranch: codebase.default_branch ?? undefined,
                  createdByPlatform: 'cli',
                }),
        }
      );
    } catch (error) {
      if (!(error instanceof TerminalStatusWriteError))
        await deps.store.failWorkflowRun(
          run.id,
          error instanceof Error ? error.message : String(error)
        );
      throw error;
    } finally {
      await liveOwner.close();
    }
  })();
  // Attach an observer immediately, including for hosts which await admission
  // before attaching to completion. The original promise still rejects to them.
  void completion.catch(error => {
    createLogger('trigger').error({ err: error, runId: run.id }, 'trigger.execution_failed');
  });
  return { admission, completion };
}
