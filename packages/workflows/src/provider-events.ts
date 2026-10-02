/**
 * What the engine does with each non-terminal event a provider streams. Both AI-node
 * loops in `dag-executor.ts` (the agent node and the loop node) hand every event to one
 * handler, so neither keeps its own per-type branches.
 *
 * Every event is recorded unchanged inside the engine envelope (see
 * `schemas/provider-event.ts`): appended to the run's JSONL log as a `provider_event`
 * line, written to the store as a `provider_event` row, and emitted in-process. The engine
 * reads an event's type only to decide side effects (what the user sees, the subtask
 * tracker); it never rebuilds the event.
 */
import type { ProviderEvent } from '@archon/providers/types';
import { toolCallDisplayName } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';

import type { IWorkflowPlatform, WorkflowMessageMetadata } from './deps';
import { getWorkflowEventEmitter } from './event-emitter';
import { safeSendMessage, type SendMessageContext } from './executor-shared';
import { logProviderEvent } from './logger';
import type { ProviderEventEnvelope } from './schemas/provider-event';
import type { IWorkflowStore } from './store';
import { formatToolCall } from './utils/tool-formatter';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.provider-events');
  return cachedLog;
}

/**
 * One node attempt's emission order. An attempt can stream more than once (a
 * structured-output reask, a loop node's iterations), and every pass shares this, so
 * `seq` stays contiguous across the attempt.
 */
export interface AttemptEventSequence {
  readonly attemptId: string;
  next(): number;
}

export function createAttemptEventSequence(attemptId: string): AttemptEventSequence {
  let seq = 0;
  return {
    attemptId,
    next: () => seq++,
  };
}

export interface ProviderEventHandlerDeps {
  store: Pick<IWorkflowStore, 'createWorkflowEvent'>;
  platform: IWorkflowPlatform;
  conversationId: string;
  messageContext: SendMessageContext;
  logDir: string;
  runId: string;
  /** The node's id, for logs. */
  nodeId: string;
  /** The persisted step name: the node id behind any loop-body prefix. */
  stepName: string;
  /** The attempt this stream pass belongs to. */
  attempt: AttemptEventSequence;
  /** MCP servers the node's `mcp:` file declares. Only their failures reach the user. */
  configuredMcpServers: ReadonlySet<string>;
  /**
   * One block of the agent's reply. The node owns its output and how the block is shown
   * (an agent node batches it; a loop node strips its completion tag).
   */
  onMessageText(text: string): Promise<void>;
  /**
   * Runs before a warning is sent. A node that holds back reply text (an agent node in
   * batch mode) sends it here, so the operator reads the reply in the order it came.
   */
  beforeWarning?(): Promise<void>;
}

export interface ProviderEventHandler {
  handle(event: ProviderEvent): Promise<void>;
  /** Subtasks that started and have not ended: the work a stream cut short would lose. */
  liveSubtaskIds(): string[];
}

/** One handler per provider stream pass: its subtask state belongs to that pass. */
export function createProviderEventHandler(deps: ProviderEventHandlerDeps): ProviderEventHandler {
  const { store, platform, conversationId, messageContext, logDir, runId, nodeId, stepName } = deps;
  const liveSubtasks = new Set<string>();

  const record = async (event: ProviderEvent): Promise<void> => {
    const envelope: ProviderEventEnvelope = {
      attemptId: deps.attempt.attemptId,
      seq: deps.attempt.next(),
      observedAt: new Date().toISOString(),
      event,
    };
    await logProviderEvent(logDir, runId, stepName, envelope);
    // Not awaited, as other observability rows are; the store logs its own failure
    // (IWorkflowStore.createWorkflowEvent never throws). The JSONL line above still
    // holds the event, and a reader sees the missing `seq` as a hole.
    void store.createWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'provider_event',
      step_name: stepName,
      data: envelope,
    });
    getWorkflowEventEmitter().emit({ type: 'provider_event', runId, stepName, ...envelope });
  };

  const sendWarning = async (
    message: string,
    logFields: Record<string, unknown>
  ): Promise<void> => {
    getLog().warn({ nodeId, ...logFields }, 'dag.provider_warning_forwarded');
    await deps.beforeWarning?.();
    const delivered = await safeSendMessage(platform, conversationId, message, messageContext);
    if (!delivered) {
      getLog().error({ nodeId, workflowRunId: runId }, 'dag.provider_warning_delivery_failed');
    }
  };

  return {
    async handle(event): Promise<void> {
      await record(event);
      const streaming = platform.getStreamingMode() === 'stream';
      switch (event.type) {
        case 'agent_message_chunk':
          await deps.onMessageText(event.text);
          return;
        case 'tool_call':
          if (streaming) {
            await safeSendMessage(
              platform,
              conversationId,
              formatToolCall(toolCallDisplayName(event), event.rawInput),
              messageContext,
              { category: 'tool_call_formatted' } as WorkflowMessageMetadata
            );
            if (platform.sendStructuredEvent) {
              await platform.sendStructuredEvent(conversationId, event);
            }
          }
          return;
        case 'tool_call_update':
          if (streaming && platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, event);
          }
          return;
        case 'warning':
          // The ⚠️ is display formatting at the platform edge; nothing reads it back.
          await sendWarning(`⚠️ ${event.message}`, { code: event.code });
          return;
        case 'mcp_server_status':
          // Servers the user's own config adds (e.g. a plugin MCP inherited from
          // ~/.claude/) routinely fail inside the headless subprocess and are not
          // actionable for the workflow author, so only the node's own servers surface.
          if (
            (event.status === 'failed' || event.status === 'needs_auth') &&
            deps.configuredMcpServers.has(event.server)
          ) {
            await sendWarning(
              `MCP server connection failed: ${event.server} (${event.status})${event.error ? `: ${event.error}` : ''}`,
              { mcpServer: event.server, mcpStatus: event.status }
            );
          } else {
            getLog().debug(
              { nodeId, mcpServer: event.server, mcpStatus: event.status },
              'dag.mcp_server_status'
            );
          }
          return;
        case 'subtask':
          if (event.status === 'started') liveSubtasks.add(event.taskId);
          else if (event.status !== 'running') liveSubtasks.delete(event.taskId);
          return;
        case 'hook':
        case 'agent_thought_chunk':
        case 'compaction':
        case 'state_update':
          // Recorded above; no other side effect.
          return;
        default: {
          const unhandled: never = event;
          throw new Error(`Unhandled provider event: ${JSON.stringify(unhandled)}`);
        }
      }
    },
    liveSubtaskIds(): string[] {
      return [...liveSubtasks];
    },
  };
}
