/**
 * What the engine does with each non-terminal event a provider streams. Both AI-node
 * loops in `dag-executor.ts` (the agent node and the loop node) hand every event to one
 * handler, so neither keeps its own per-type branches. The engine reads an event's type
 * only to decide side effects; it never rebuilds the event.
 *
 * The rows, emitter events and JSONL lines written here are today's
 * `tool_called`/`tool_completed`/`task_activity`/`hook_activity` and `assistant`/`tool`
 * shapes, translated from the event. They are a bridge until the engine records the
 * event itself in an envelope (#3569).
 */
import type { ProviderEvent } from '@archon/providers/types';
import { toolCallDisplayName } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';

import type { IWorkflowPlatform, WorkflowMessageMetadata } from './deps';
import { getWorkflowEventEmitter } from './event-emitter';
import { safeSendMessage, type SendMessageContext } from './executor-shared';
import { logAssistant, logTool } from './logger';
import type { IWorkflowStore } from './store';
import { formatToolCall } from './utils/tool-formatter';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.provider-events');
  return cachedLog;
}

type SubtaskEvent = Extract<ProviderEvent, { type: 'subtask' }>;
type HookEvent = Extract<ProviderEvent, { type: 'hook' }>;

const TOOL_OUTCOME = {
  completed: 'success',
  failed: 'error',
  cancelled: 'interrupted',
} as const;

/**
 * Longest string input value written to the JSONL log and the `tool_called` row. A Write
 * or Edit call carries whole file contents, which neither record needs.
 */
const TOOL_INPUT_VALUE_MAX_CHARS = 500;

function recordedToolInput(rawInput: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!rawInput) return {};
  return Object.fromEntries(
    Object.entries(rawInput).map(([key, value]) =>
      typeof value === 'string' && value.length > TOOL_INPUT_VALUE_MAX_CHARS
        ? [key, `${value.slice(0, TOOL_INPUT_VALUE_MAX_CHARS)}...`]
        : [key, value]
    )
  );
}

const HOOK_OUTCOME = {
  succeeded: 'success',
  failed: 'error',
  cancelled: 'cancelled',
} as const;

const SUBTASK_ACTIVITY = {
  started: 'started',
  running: 'progress',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
} as const;

export interface ProviderEventHandlerDeps {
  store: Pick<IWorkflowStore, 'createWorkflowEvent'>;
  platform: IWorkflowPlatform;
  conversationId: string;
  messageContext: SendMessageContext;
  logDir: string;
  runId: string;
  /** The node's id, which in-process emitter payloads carry. */
  nodeId: string;
  /** The persisted step name: the node id behind any loop-body prefix. */
  stepName: string;
  /** MCP servers the node's `mcp:` file declares. Only their failures reach the user. */
  configuredMcpServers: ReadonlySet<string>;
  /**
   * One block of the agent's reply. The node owns its output and how the block is shown
   * (an agent node batches it; a loop node strips its completion tag).
   */
  onMessageText(text: string): Promise<void>;
}

export interface ProviderEventHandler {
  handle(event: ProviderEvent): Promise<void>;
  /** Subtasks that started and have not ended: the work a stream cut short would lose. */
  liveSubtaskIds(): string[];
}

/** One handler per provider stream pass: its tool and subtask state belongs to that pass. */
export function createProviderEventHandler(deps: ProviderEventHandlerDeps): ProviderEventHandler {
  const { store, platform, conversationId, messageContext, logDir, runId, nodeId, stepName } = deps;
  const runningTools = new Map<string, { toolName: string; startedAt: number }>();
  const liveSubtasks = new Set<string>();

  const persist = (
    eventType: 'tool_called' | 'tool_completed' | 'task_activity' | 'hook_activity',
    data: Record<string, unknown>
  ): void => {
    store
      .createWorkflowEvent({
        workflow_run_id: runId,
        event_type: eventType,
        step_name: stepName,
        data,
      })
      .catch((err: Error) => {
        getLog().error({ err, workflowRunId: runId, eventType }, 'workflow_event_persist_failed');
      });
  };

  const sendWarning = async (
    message: string,
    logFields: Record<string, unknown>
  ): Promise<void> => {
    getLog().warn({ nodeId, ...logFields }, 'dag.provider_warning_forwarded');
    const delivered = await safeSendMessage(platform, conversationId, message, messageContext);
    if (!delivered) {
      getLog().error({ nodeId, workflowRunId: runId }, 'dag.provider_warning_delivery_failed');
    }
  };

  const recordSubtask = (event: SubtaskEvent): void => {
    if (event.status === 'started') liveSubtasks.add(event.taskId);
    else if (event.status !== 'running') liveSubtasks.delete(event.taskId);
    const activity = SUBTASK_ACTIVITY[event.status];
    getWorkflowEventEmitter().emit({
      type: 'task_activity',
      runId,
      nodeId,
      taskId: event.taskId,
      activity,
      ...(event.description !== undefined ? { description: event.description } : {}),
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
      ...(event.lastToolName !== undefined ? { lastToolName: event.lastToolName } : {}),
      ...(event.taskType !== undefined ? { taskType: event.taskType } : {}),
      ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
    });
    persist('task_activity', {
      task_id: event.taskId,
      activity,
      ...(event.description !== undefined ? { description: event.description } : {}),
      ...(event.summary !== undefined ? { summary: event.summary } : {}),
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
      ...(event.lastToolName !== undefined ? { last_tool_name: event.lastToolName } : {}),
      ...(event.taskType !== undefined ? { task_type: event.taskType } : {}),
      ...(event.outputFile !== undefined ? { output_file: event.outputFile } : {}),
    });
  };

  const recordHook = (event: HookEvent): void => {
    const outcome = event.status === 'started' ? undefined : HOOK_OUTCOME[event.status];
    const activity = outcome === undefined ? 'started' : 'response';
    getWorkflowEventEmitter().emit({
      type: 'hook_activity',
      runId,
      nodeId,
      hookId: event.hookId,
      hookName: event.hookName,
      hookEvent: event.hookEvent,
      activity,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    });
    persist('hook_activity', {
      hook_id: event.hookId,
      hook_name: event.hookName,
      hook_event: event.hookEvent,
      activity,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
    });
  };

  return {
    async handle(event): Promise<void> {
      const streaming = platform.getStreamingMode() === 'stream';
      switch (event.type) {
        case 'agent_message_chunk':
          await deps.onMessageText(event.text);
          await logAssistant(logDir, runId, event.text);
          return;
        case 'tool_call': {
          const toolName = toolCallDisplayName(event);
          const toolInput = recordedToolInput(event.rawInput);
          runningTools.set(event.toolCallId, { toolName, startedAt: Date.now() });
          getWorkflowEventEmitter().emit({
            type: 'tool_started',
            runId,
            toolName,
            stepName: nodeId,
            toolCallId: event.toolCallId,
          });
          if (streaming) {
            await safeSendMessage(
              platform,
              conversationId,
              formatToolCall(toolName, event.rawInput),
              messageContext,
              { category: 'tool_call_formatted' } as WorkflowMessageMetadata
            );
            if (platform.sendStructuredEvent) {
              await platform.sendStructuredEvent(conversationId, event);
            }
          }
          await logTool(logDir, runId, toolName, toolInput);
          persist('tool_called', {
            tool_name: toolName,
            tool_input: toolInput,
            tool_call_id: event.toolCallId,
          });
          return;
        }
        case 'tool_call_update': {
          const tool = runningTools.get(event.toolCallId);
          if (tool) {
            runningTools.delete(event.toolCallId);
            const durationMs = Date.now() - tool.startedAt;
            const toolOutcome = TOOL_OUTCOME[event.status];
            getWorkflowEventEmitter().emit({
              type: 'tool_completed',
              runId,
              toolName: tool.toolName,
              stepName: nodeId,
              durationMs,
              toolCallId: event.toolCallId,
              toolOutcome,
              ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
            });
            persist('tool_completed', {
              tool_name: tool.toolName,
              duration_ms: durationMs,
              tool_call_id: event.toolCallId,
              tool_outcome: toolOutcome,
              ...(event.exitCode !== undefined ? { exit_code: event.exitCode } : {}),
            });
          } else {
            // The contract forbids this (conformance rule 3); record the provider's mistake.
            getLog().warn(
              { nodeId, toolCallId: event.toolCallId },
              'provider_events.tool_update_without_call'
            );
          }
          if (streaming && platform.sendStructuredEvent) {
            await platform.sendStructuredEvent(conversationId, event);
          }
          return;
        }
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
          recordSubtask(event);
          return;
        case 'hook':
          recordHook(event);
          return;
        case 'agent_thought_chunk':
        case 'compaction':
        case 'state_update':
          // No reader yet: they reset the idle watchdog by arriving.
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
