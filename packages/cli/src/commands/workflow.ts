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
export { workflowAttentionCommand, workflowAttentionLabelCommand } from './workflow-attention';
export {
  workflowAbandonCommand,
  workflowAnswerCommand,
  workflowApproveCommand,
  workflowCancelCommand,
  workflowRejectCommand,
  workflowRespondCommand,
  workflowResumeCommand,
} from './workflow-control';

/**
 * Reset persisted per-node provider sessions for a workflow.
 *
 * Filter rules:
 *   - workflow-name required (positional)
 *   - --scope <key>: restrict to one scope (e.g. a conversation UUID); when
 *     omitted, deletes across ALL scopes (use --yes to skip the confirmation)
 *   - --node <id>: restrict to one node within the scope
 *   - --json: machine-readable output
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

/**
 * Delete terminal workflow runs older than the given number of days.
 */
export async function workflowCleanupCommand(host: WorkflowHost, days: number): Promise<void> {
  let deleted: number | undefined;
  try {
    const { count } = await host.deps.store.deleteOldWorkflowRuns(days);
    deleted = count;
    const { count: revisions } = await host.deps.store.pruneStateRevisions(days);
    console.log(`Pruned ${revisions} state revision(s) older than ${days} days.`);
    if (count === 0) {
      console.log(`No workflow runs older than ${days} days to clean up.`);
    } else {
      console.log(`Deleted ${count} workflow run(s) older than ${days} days.`);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, days, deleted }, 'cli.workflow_cleanup_failed');
    if (deleted !== undefined)
      throw new Error(
        `Deleted ${deleted} workflow run(s) older than ${days} days, but failed to prune state revisions: ${err.message}`,
        { cause: error }
      );
    throw new Error(`Failed to clean up workflow history: ${err.message}`, { cause: error });
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
