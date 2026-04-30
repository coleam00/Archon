/**
 * Production bridge factory — wires `BridgeDeps` against the real Archon
 * plumbing. Imported by the server bootstrap so the orchestrator can launch
 * actual workflow runs.
 *
 * The deep imports (`@archon/core/orchestrator/orchestrator`,
 * `@archon/workflows/executor`, `@archon/core/workflows/store-adapter`) are
 * intentional: these symbols are not on the stable public surface of
 * `@archon/core` / `@archon/workflows`, but they are the canonical entry
 * points used by Archon's own background-dispatch path
 * (`packages/core/src/orchestrator/orchestrator.ts:dispatchBackgroundWorkflow`).
 */
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import { validateAndResolveIsolation } from '@archon/core/orchestrator';
import { createWorkflowDeps } from '@archon/core/workflows/store-adapter';
import { loadConfig as loadMergedConfig } from '@archon/core/config';
import { executeWorkflow } from '@archon/workflows/executor';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { createLogger } from '@archon/paths';
import type { BridgeCodebase, BridgeDeps, BridgeWebAdapter, RunWorkflowFn } from './types';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('symphony.bridge');
  return cachedLog;
}

export interface CreateProductionBridgeOptions {
  webAdapter: BridgeWebAdapter;
}

export function createProductionBridge(opts: CreateProductionBridgeOptions): BridgeDeps {
  const workflowDeps = createWorkflowDeps();

  const resolveWorkflow = async (name: string, cwd: string): Promise<WorkflowDefinition | null> => {
    const result = await discoverWorkflowsWithConfig(cwd, loadMergedConfig);
    const match = result.workflows.find(w => w.workflow.name === name);
    return match ? match.workflow : null;
  };

  const loadCodebase = async (codebaseId: string): Promise<BridgeCodebase | null> => {
    const cb = await codebaseDb.getCodebase(codebaseId);
    if (!cb) return null;
    return { id: cb.id, name: cb.name, default_cwd: cb.default_cwd };
  };

  const resolveIsolation: BridgeDeps['resolveIsolation'] = async ({
    conversation,
    codebase,
    platform,
  }) => {
    // Look up the persisted conversation row — `validateAndResolveIsolation`
    // expects the full Conversation type, including `isolation_env_id` and
    // `cwd`. We just created this row, so a fresh fetch is safe.
    const conv = await conversationDb.findConversationByPlatformId(
      conversation.platform_conversation_id
    );
    if (!conv) {
      throw new Error(
        `bridge: worker conversation ${conversation.platform_conversation_id} disappeared between create and isolation resolve`
      );
    }
    const cbFull = await codebaseDb.getCodebase(codebase.id);
    if (!cbFull) {
      throw new Error(`bridge: codebase ${codebase.id} disappeared`);
    }
    const result = await validateAndResolveIsolation(
      conv,
      cbFull,
      platform as Parameters<typeof validateAndResolveIsolation>[2],
      conversation.platform_conversation_id,
      { workflowType: 'thread', workflowId: conversation.platform_conversation_id }
    );
    return { cwd: result.cwd };
  };

  const createWorkerConversation: BridgeDeps['createWorkerConversation'] = async input => {
    const conv = await conversationDb.getOrCreateConversation(
      'web',
      input.platformConversationId,
      input.codebaseId
    );
    await conversationDb.updateConversation(conv.id, {
      cwd: input.cwd,
      codebase_id: input.codebaseId,
      hidden: true,
    });
    return { id: conv.id, platform_conversation_id: input.platformConversationId };
  };

  const runWorkflow: RunWorkflowFn = async input => {
    const run = await workflowDeps.store.getWorkflowRun(input.preCreatedRunId);
    if (!run) {
      // Symphony already wrote the dispatch row with this run id — losing
      // the row here is unexpected. Surface and bail; the orchestrator's
      // event listener will never receive a terminal event for this run, so
      // the dispatch will eventually be reconciled at the next service start.
      getLog().error(
        { run_id: input.preCreatedRunId },
        'symphony.bridge.pre_created_run_disappeared'
      );
      return;
    }
    try {
      await executeWorkflow(
        workflowDeps,
        opts.webAdapter,
        input.workerPlatformId,
        input.cwd,
        input.workflow,
        input.userMessage,
        input.workerConversationDbId,
        input.codebaseId,
        undefined,
        undefined,
        undefined,
        run
      );
    } catch (err) {
      // executeWorkflow handles its own failures via the event emitter, but
      // if we get here something escaped. Surface to logs; the run row is
      // likely already marked failed by the executor.
      getLog().error(
        { err: err as Error, run_id: input.preCreatedRunId },
        'symphony.bridge.execute_threw'
      );
    }
  };

  return {
    workflowDeps,
    platform: opts.webAdapter,
    resolveWorkflow,
    loadCodebase,
    resolveIsolation,
    createWorkerConversation,
    runWorkflow,
  };
}
