/**
 * The `archon workflow` route module `cli.ts` loads: every subcommand's entry point, and
 * the maintenance commands (session reset, history cleanup, event emit).
 */

import { checkoutSharedEventDataSchema } from '@archon/workflows/schemas/workflow-event';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import {
  WORKFLOW_EVENT_TYPES,
  isDurableWorkflowEventType,
  type WorkflowEventType,
} from '@archon/workflows/store';
import { writeStdout } from '../utils/stdout';
import { getLog, resolveRunIdArg } from './workflow-shared';

export { workflowRunCommand } from './workflow-run-owned';
export { workflowCleanupCommand, workflowOrphanCleanupCommand } from './workflow-cleanup';
export {
  WorkflowListLookupError,
  workflowGetCommand,
  workflowListCommand,
  workflowLogsCommand,
  workflowRunsCommand,
  workflowStatusCommand,
  workflowTestCommand,
  workflowWaitCommand,
} from './workflow-query';
export {
  workflowAbandonItemCommand,
  workflowCancelItemCommand,
  workflowWaitItemCommand,
} from './workflow-item-runs';
export { workflowAttentionCommand, workflowAttentionLabelCommand } from './workflow-attention';
export { workflowNoticeCommand, WORKFLOW_NOTICE_USAGE } from './workflow-notice';
export { workflowRuleCommand, WORKFLOW_RULE_USAGE } from './workflow-rule';
export { workflowItemsCommand, WORKFLOW_ITEMS_USAGE } from './workflow-items';
export { workflowMergedCommand, WORKFLOW_MERGED_USAGE } from './workflow-merged';
export { workflowLandingCommand, WORKFLOW_LANDING_USAGE } from './workflow-landing';
export { workflowTitleCommand, WORKFLOW_TITLE_USAGE } from './workflow-title';
export { workflowLinkCommand, WORKFLOW_LINK_USAGE } from './workflow-link';
export { workflowAnswerRefCommand, WORKFLOW_ANSWER_REF_USAGE } from './workflow-answer-ref';
export {
  workflowAbandonCommand,
  workflowAnswerCommand,
  workflowApproveCommand,
  workflowCancelCommand,
  workflowPauseCommand,
  workflowRejectCommand,
  workflowRespondCommand,
  workflowResumeCommand,
} from './workflow-control';

/**
 * Reset persisted per-node provider sessions for a workflow.
 */
export async function workflowResetSessionsCommand(
  host: WorkflowHost,
  workflowName: string,
  options: { scope?: string; node?: string; yes?: boolean; json?: boolean }
): Promise<void> {
  const { resetWorkflowNodeSessions } = host.operations;

  if (!options.scope && !options.yes) {
    throw new Error(
      `Refusing to delete every persisted session for workflow '${workflowName}' across all scopes without confirmation.\n` +
        'Pass --scope <key> to narrow, or --yes to confirm cross-scope reset.'
    );
  }
  try {
    const { deleted } = await resetWorkflowNodeSessions({
      workflow_name: workflowName,
      scope_key: options.scope,
      node_id: options.node,
    });
    if (options.json) {
      await writeStdout(
        `${JSON.stringify({
          workflow: workflowName,
          deleted,
          scope: options.scope ?? null,
          node: options.node ?? null,
        })}\n`
      );
    } else if (deleted === 0) {
      console.log(`No persisted sessions matched for workflow '${workflowName}'.`);
    } else {
      const scope = options.scope ? ` in scope '${options.scope}'` : ' across all scopes';
      const node = options.node ? ` for node '${options.node}'` : '';
      console.log(
        `Deleted ${deleted} persisted session(s) for workflow '${workflowName}'${node}${scope}.`
      );
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, workflowName, ...options }, 'cli.workflow_reset_sessions_failed');
    throw new Error(`Failed to reset workflow sessions: ${err.message}`);
  }
}

export function isValidEventType(value: string): value is WorkflowEventType {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Emit a workflow event directly to the database.
 * Required event writes propagate storage failures; ordinary observability remains best-effort.
 */
export async function workflowEventEmitCommand(
  host: WorkflowHost,
  runId: string,
  eventType: WorkflowEventType,
  data?: Record<string, unknown>,
  cwd?: string
): Promise<void> {
  const resolvedId = await resolveRunIdArg(host, runId, cwd, true);
  const store = host.deps.store;
  if (eventType === 'workflow.checkout_shared') {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data: checkoutSharedEventDataSchema.parse(data),
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  if (isDurableWorkflowEventType(eventType)) {
    await store.persistWorkflowEvent({
      workflow_run_id: resolvedId,
      event_type: eventType,
      data,
    });
    console.log(`Event persisted: ${eventType} for run ${resolvedId}`);
    return;
  }
  await store.createWorkflowEvent({
    workflow_run_id: resolvedId,
    event_type: eventType,
    data,
  });
  // createWorkflowEvent is non-throwing (fire-and-forget) — the event may not
  // have been persisted if the DB was unavailable. Check server logs if missing.
  console.log(`Event submitted (best-effort): ${eventType} for run ${resolvedId}`);
}
