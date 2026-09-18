/**
 * Maps a persisted `workflow_events` DB row (`PersistedWorkflowEvent`, `store.ts`)
 * to the in-process `WorkflowEmitterEvent` shape (`engine-port.ts`'s `WorkflowEvent`
 * alias) that `IWorkflowEngine.subscribe()` (#3334 M6) delivers to listeners.
 *
 * This is the inverse direction of `@archon/server`'s `mapWorkflowEventRow`
 * (DB row → dashboard SSE JSON): that mapper is for the Web dashboard and
 * deliberately drops high-frequency `tool_*` rows; this one exists so the CLI's
 * `subscribe()`-based renderer sees the same event shape it always has,
 * including `tool_*` in verbose mode.
 *
 * Narrow by design (YAGNI): only the event types `renderWorkflowEvent`
 * (`packages/cli/src/commands/workflow.ts`) actually switches on are mapped.
 * Every other persisted type (workflow lifecycle, loop iterations, waits,
 * quota, artifacts, session bookkeeping, ...) returns `null` and is dropped —
 * the CLI's own `default:` case already treats them as "intentionally not
 * rendered", so there is nothing today's `subscribeForConversation` path
 * rendered that this silently loses, with one accepted gap: `workflow_started`
 * has no persisted `transcriptPath` (it's derived in-process from `outputRoot`
 * at emit time — see `executor.ts`), so it cannot be reconstructed from the DB
 * row alone and is intentionally not mapped here (see M6 handoff notes).
 */
import { nodeSkipReasonSchema, skipCauseSchema } from './schemas/workflow-run';
import { effortLevelSchema } from './schemas/effort';
import type { PersistedWorkflowEvent } from './store';
import type { WorkflowEvent } from './engine-port';

function str(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function num(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/** `container_*`/`writeback_*` DB event types → the emitter's single `container_lifecycle` phase field. */
const CONTAINER_EVENT_PHASE: Record<
  string,
  Extract<WorkflowEvent, { type: 'container_lifecycle' }>['phase']
> = {
  container_created: 'created',
  container_stopped: 'stopped',
  container_resumed: 'resumed',
  container_destroyed: 'destroyed',
  writeback_requested: 'writeback_requested',
  writeback_applied: 'writeback_applied',
  writeback_discarded: 'writeback_discarded',
};

/**
 * `nodeId`/`nodeName` for a node-lifecycle row. `data.node_id`/`data.command` are
 * written on `node_completed`/`node_failed` (`nodeIdentityData`, #3334 M4); older
 * rows and `node_started` fall back to `step_name`, which is the same value minus
 * any loop/fan-out namespacing prefix in the common (non-nested) case.
 */
function nodeId(row: PersistedWorkflowEvent): string {
  return str(row.data, 'node_id') ?? row.step_name ?? '';
}

function nodeName(row: PersistedWorkflowEvent): string {
  return str(row.data, 'command') ?? nodeId(row);
}

export function mapPersistedEventToEmitterEvent(row: PersistedWorkflowEvent): WorkflowEvent | null {
  switch (row.event_type) {
    case 'node_started': {
      const provider = str(row.data, 'provider');
      const model = str(row.data, 'model');
      const tier = str(row.data, 'tier');
      const effortParsed = effortLevelSchema.safeParse(row.data.effort);
      return {
        type: 'node_started',
        runId: row.workflow_run_id,
        nodeId: nodeId(row),
        nodeName: nodeName(row),
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(tier === 'small' || tier === 'medium' || tier === 'large' ? { tier } : {}),
        ...(effortParsed.success ? { effort: effortParsed.data } : {}),
      };
    }

    case 'node_completed':
      return {
        type: 'node_completed',
        runId: row.workflow_run_id,
        nodeId: nodeId(row),
        nodeName: nodeName(row),
        duration: num(row.data, 'duration_ms') ?? 0,
        ...(num(row.data, 'cost_usd') !== undefined ? { costUsd: num(row.data, 'cost_usd') } : {}),
        ...(str(row.data, 'stop_reason') !== undefined
          ? { stopReason: str(row.data, 'stop_reason') }
          : {}),
        ...(num(row.data, 'num_turns') !== undefined
          ? { numTurns: num(row.data, 'num_turns') }
          : {}),
      };

    case 'node_failed':
      return {
        type: 'node_failed',
        runId: row.workflow_run_id,
        nodeId: nodeId(row),
        nodeName: nodeName(row),
        error: str(row.data, 'error') ?? '',
      };

    case 'node_skipped_prior_success':
      return {
        type: 'node_skipped',
        runId: row.workflow_run_id,
        nodeId: nodeId(row),
        nodeName: nodeName(row),
        reason: 'prior_success',
      };

    case 'node_skipped': {
      const reasonParsed = nodeSkipReasonSchema.safeParse(row.data.reason);
      const reason = reasonParsed.success ? reasonParsed.data : 'timeout';
      const base = {
        type: 'node_skipped' as const,
        runId: row.workflow_run_id,
        nodeId: nodeId(row),
        nodeName: nodeName(row),
      };
      if (reason === 'prior_success') return { ...base, reason };
      const causeParsed = skipCauseSchema.safeParse(row.data.cause);
      return {
        ...base,
        reason,
        cause: causeParsed.success ? causeParsed.data : { kind: 'timeout' },
      };
    }

    case 'tool_called':
      return {
        type: 'tool_started',
        runId: row.workflow_run_id,
        toolName: str(row.data, 'tool_name') ?? '',
        stepName: row.step_name ?? '',
        toolCallId: str(row.data, 'tool_call_id') ?? '',
      };

    case 'tool_completed': {
      const toolOutcome = str(row.data, 'tool_outcome');
      const exitCode = num(row.data, 'exit_code');
      return {
        type: 'tool_completed',
        runId: row.workflow_run_id,
        toolName: str(row.data, 'tool_name') ?? '',
        stepName: row.step_name ?? '',
        durationMs: num(row.data, 'duration_ms') ?? 0,
        toolCallId: str(row.data, 'tool_call_id') ?? '',
        ...(toolOutcome === 'success' ||
        toolOutcome === 'error' ||
        toolOutcome === 'interrupted' ||
        toolOutcome === 'unknown'
          ? { toolOutcome }
          : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
    }

    case 'approval_requested':
      return {
        type: 'approval_pending',
        runId: row.workflow_run_id,
        nodeId: row.step_name ?? str(row.data, 'nodeId', 'node_id') ?? '',
        message: str(row.data, 'message') ?? '',
      };

    case 'workflow_cancelled':
      return {
        type: 'workflow_cancelled',
        runId: row.workflow_run_id,
        nodeId: row.step_name ?? '',
        reason: str(row.data, 'reason') ?? '',
      };

    default: {
      const phase = CONTAINER_EVENT_PHASE[row.event_type];
      if (phase) {
        const containerId = str(row.data, 'containerId', 'container_id');
        return {
          type: 'container_lifecycle',
          runId: row.workflow_run_id,
          phase,
          ...(containerId !== undefined ? { containerId } : {}),
        };
      }
      // Every other persisted type (workflow_started/completed/failed, loop
      // iterations, waits, quota, artifacts, session bookkeeping, ...) is
      // intentionally not rendered by the CLI's `renderWorkflowEvent` and is
      // dropped here rather than partially reconstructed.
      return null;
    }
  }
}
