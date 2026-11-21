/**
 * The engine's message to a stalled session. When a node attempt's stream has a stall
 * raised by tool-call attention, the engine writes one factual message into the same
 * live provider session, the way an operator types "idle?" into a stuck session, and
 * the agent decides what to do. The engine never ends or interrupts the call: that stays
 * the operator's `end-turn` or cancel. Messages are bounded per attempt and spaced by the
 * attention threshold; past the bound the stall is left to attention as before.
 */
import { createLogger } from '@archon/paths';
import { logWorkflowEvent } from './logger';
import { createTurnMessageQueue, type ProviderCapabilities } from '@archon/provider-contract';
import {
  DEFAULT_STALL_MESSAGE_LIMIT,
  DEFAULT_TOOL_CALL_ATTENTION_MS,
  type WorkflowContinuationConfig,
} from './schemas/run-config';
import type { StallMessageEventData } from './schemas/workflow-event';
import type { IWorkflowStore } from './store';
import type { StreamStall } from './tool-call-attention';

export interface StallMessengerOptions {
  store: Pick<IWorkflowStore, 'createWorkflowEvent'>;
  /** Where the run's transcript lives: every record is also a transcript row. */
  logDir: string;
  runId: string;
  /** The persisted step name the events are written under. */
  stepName: string;
  provider: string;
  /** The loop iteration, for a loop node. */
  iteration?: number;
  capabilities: Pick<ProviderCapabilities, 'turnMessages'>;
  /** The run's `workflows` policy: `stallMessageLimit` and `toolCallAttentionMs`. */
  policy: Pick<WorkflowContinuationConfig, 'stallMessageLimit' | 'toolCallAttentionMs'> | undefined;
  now?: () => number;
}

/** One stream pass's channel: what its sendQuery receives, and the check its stop check runs. */
export interface StallMessagePass {
  /** `turnMessages` for this pass's sendQuery; undefined when nothing will be sent. */
  readonly turnMessages: AsyncIterable<string> | undefined;
  /** Sends a message when the pass's current stall calls for one. */
  check(stall: StreamStall | undefined): Promise<void>;
  /** The provider refused the last message it was handed; `error` is its report. */
  refused(error: string): Promise<void>;
  close(): void;
}

/** A pass that sends nothing: messages are off, or the provider cannot take one. */
const SILENT_PASS: StallMessagePass = {
  turnMessages: undefined,
  check: () => Promise.resolve(),
  refused: () => Promise.resolve(),
  close: () => undefined,
};

/** Listed calls per message; the rest are counted. */
const LISTED_CALLS = 3;

/**
 * One node attempt's messenger. The count spans the attempt's passes (a structured-output
 * reask is another pass of the same attempt); each pass gets its own channel, because
 * each sendQuery is its own live session.
 */
export function createStallMessenger(options: StallMessengerOptions): {
  openPass(): StallMessagePass;
} {
  const now = options.now ?? Date.now;
  const supported = options.capabilities.turnMessages === true;
  const limit = options.policy?.stallMessageLimit ?? DEFAULT_STALL_MESSAGE_LIMIT;
  const thresholdMs = options.policy?.toolCallAttentionMs ?? DEFAULT_TOOL_CALL_ATTENTION_MS;
  const enabled = limit > 0 && thresholdMs > 0;
  let count = 0;
  let lastSentAt = 0;
  let unsupportedRecorded = false;

  // Both writers log their own failure and never throw: observability must not fail live work.
  const record = async (data: StallMessageEventData): Promise<void> => {
    await options.store.createWorkflowEvent({
      workflow_run_id: options.runId,
      event_type: 'stall_message',
      step_name: options.stepName,
      data,
    });
    await logWorkflowEvent(options.logDir, options.runId, {
      type: 'stall_message',
      step: options.stepName,
      stall_message: data,
    });
  };
  const logFields = {
    workflowRunId: options.runId,
    nodeId: options.stepName,
    provider: options.provider,
    ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
  };

  async function recordUnsupported(): Promise<void> {
    if (unsupportedRecorded) return;
    unsupportedRecorded = true;
    createLogger('workflow.stall-message').warn(logFields, 'workflow.stall_message_unsupported');
    await record({
      sent: false,
      reason: 'provider_unsupported',
      provider: options.provider,
      ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
    });
  }

  return {
    openPass(): StallMessagePass {
      if (!enabled) return SILENT_PASS;
      if (!supported) {
        return {
          ...SILENT_PASS,
          check: async stall => {
            if (stall !== undefined) await recordUnsupported();
          },
        };
      }
      const queue = createTurnMessageQueue();
      return {
        turnMessages: queue,
        close: () => {
          queue.close();
        },
        async refused(error): Promise<void> {
          createLogger('workflow.stall-message').warn(
            { ...logFields, count, limit },
            'workflow.stall_message_refused'
          );
          await record({
            sent: false,
            reason: 'provider_refused',
            provider: options.provider,
            ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
            ...(count > 0 ? { count, limit } : {}),
            error,
          });
        },
        async check(stall): Promise<void> {
          if (stall === undefined || stall.length === 0 || count >= limit) return;
          const time = now();
          if (count > 0 && time - lastSentAt < thresholdMs) return;
          const open = stall.map(call => ({
            toolCallId: call.toolCallId,
            name: call.name,
            ...(call.title !== undefined ? { title: call.title } : {}),
            openForMs: Math.max(0, time - Date.parse(call.startedAt)),
            noProgressMs: Math.max(0, time - Date.parse(call.lastProgressAt)),
          }));
          const text = stallMessageText(open, count + 1, limit);
          // A closed pass took nothing; the next pass's check tries again.
          if (!queue.push(text)) return;
          count += 1;
          lastSentAt = time;
          createLogger('workflow.stall-message').info(
            { ...logFields, count, limit, openCalls: open.length },
            'workflow.stall_message_sent'
          );
          await record({
            sent: true,
            sender: 'engine',
            provider: options.provider,
            ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
            count,
            limit,
            open,
            text,
          });
        },
      };
    },
  };
}

interface OpenCall {
  toolCallId: string;
  name: string;
  title?: string;
  openForMs: number;
  noProgressMs: number;
}

/**
 * The message: facts only. How long the stalled work has shown no progress and what is
 * open. It gives no instruction about the work; the agent may say it is waiting on
 * purpose and keep waiting.
 */
function stallMessageText(open: readonly OpenCall[], count: number, limit: number): string {
  const quiet = Math.min(...open.map(call => call.noProgressMs));
  const listed = open.slice(0, LISTED_CALLS).map(call => {
    const kind = call.toolCallId.startsWith('subtask:') ? 'background task' : 'tool call';
    const title = call.title ? ` ("${call.title}")` : '';
    return `- ${kind} ${call.name}${title}, open for ${duration(call.openForMs)}`;
  });
  const more = open.length - listed.length;
  return [
    `Archon engine check-in (automatic message ${String(count)} of ${String(limit)}): ` +
      `no progress has been reported for ${duration(quiet)} on this open work:`,
    ...listed,
    ...(more > 0 ? [`- and ${String(more)} more`] : []),
    'This message carries no instruction about your work. ' +
      'If you are waiting on purpose, you can say so and keep waiting.',
  ].join('\n');
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const seconds = Math.floor(ms / 1000);
  return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
}
