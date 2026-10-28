/**
 * Normalizes the raw Claude SDK event stream of one query into Archon MessageChunks:
 * assistant content and tool calls, tool results, system lifecycle frames (session
 * state, subtasks, compaction, hooks, MCP status, API retries), rate-limit reports,
 * and the typed `result` each turn ends in.
 */
import type {
  McpServerStatus,
  SDKAPIRetryMessage,
  SDKAssistantMessageError,
  SDKBackgroundTasksChangedMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { sessionPreview, toolCallSchema, truncateToolOutput } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import type { MessageChunk, ProviderEvent, ProviderWarning } from '../types';
import { classifyClaudeApiError, failureOf, failureResultChunk } from './failure';
import {
  judgeResult,
  logResultVerdict,
  resultChunk,
  resultUsage,
  type ResultSpendState,
  type SyntheticError,
} from './result';
import type { SpendBaseline } from './session-spend';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude');
  return cachedLog;
}

/** Queued tool result from SDK hooks, consumed during stream normalization. */
export type ToolResultEntry = Extract<ProviderEvent, { type: 'tool_call_update' }>;

/**
 * Content block type for assistant messages
 */
interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use';
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

interface AssistantMessage {
  message: { content: ContentBlock[]; model?: string };
  error?: SDKAssistantMessageError;
}

/** A content block of a `user` message; only `tool_result` blocks are read. */
interface ToolResultBlock {
  type: string;
  tool_use_id: string;
  is_error?: boolean;
  content?: string | { type: string; text?: string }[];
}

interface SystemMessage {
  subtype?: string;
  mcp_servers?: Pick<McpServerStatus, 'name' | 'status' | 'error'>[];
  // Subagent task lifecycle (Claude SDK v0.2.89+)
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  prompt?: string;
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  last_tool_name?: string;
  status?: string;
  output_file?: string;
  skip_transcript?: boolean;
  ambient?: boolean;
  // Session state (CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)
  state?: string;
  // Compaction (`status` and `compact_boundary`)
  compact_metadata?: { trigger: 'manual' | 'auto'; pre_tokens: number; post_tokens?: number };
  // Hook lifecycle (Claude SDK v0.2.89+)
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  outcome?: 'success' | 'error' | 'cancelled';
  exit_code?: number;
}

/** A system frame whose task id is present. */
type TaskMessage = SystemMessage & { task_id: string };

/** Whether the stream reads on after an event, or the query is over. */
type StreamStep = 'next' | 'stop';

/** The query-lifetime facts the event handlers read and update. */
interface StreamState extends ResultSpendState {
  readonly toolResultQueue: ToolResultEntry[];
  readonly closeInput: () => void;
  // Synthetic error message recorded while waiting for the terminal result to
  // confirm it (#1797). Detection is two-signal: the typed wrapper `error`
  // field on a '<synthetic>' assistant message, then `is_error: true` on the
  // result.
  pendingSdkError: SyntheticError | undefined;
  // The last subscription-window report; a failure reads it to tell an exhausted
  // window (`status: 'rejected'`) from load shedding.
  lastRateLimit: SDKRateLimitInfo | undefined;
  // A wake turn must report its own result before idle can settle it.
  resultSeen: boolean;
  resultReported: boolean;
  backgroundObserved: boolean;
  idleReached: boolean;
  // Progress frames carry no visibility marker, so retain the start decision
  // for the lifetime of this query and suppress the complete hidden lifecycle.
  readonly hiddenTaskIds: Set<string>;
  // Tasks announced as subtasks. Their notification closes them even when it is marked
  // ambient, so a subtask the reader saw start never stays open.
  readonly visibleTaskIds: Set<string>;
  liveBackgroundIds: Set<string>;
  // Tool calls yielded and not yet closed. The PostToolUse hooks close most of them with
  // their output; a call no hook reports (a permission denial) closes from the
  // `tool_result` block the CLI sends back to the model. Whichever arrives first closes
  // the call, and a hook result for a call that is not open is dropped, so a call is
  // never closed twice or closed without a start.
  readonly openToolIds: Set<string>;
}

/**
 * Normalize raw Claude SDK events into Archon MessageChunks.
 * Drains the tool result queue between events (populated by SDK hooks).
 */
export async function* streamClaudeMessages(
  events: AsyncGenerator,
  toolResultQueue: ToolResultEntry[],
  spendBaseline: SpendBaseline,
  closeInput: () => void
): AsyncGenerator<MessageChunk> {
  const state: StreamState = {
    toolResultQueue,
    closeInput,
    spendBaseline,
    pendingSdkError: undefined,
    lastRateLimit: undefined,
    resultSeen: false,
    queryTokensUnknown: false,
    resultReported: false,
    backgroundObserved: false,
    idleReached: false,
    hiddenTaskIds: new Set(),
    visibleTaskIds: new Set(),
    liveBackgroundIds: new Set(),
    openToolIds: new Set(),
  };

  for await (const msg of events) {
    // Drain tool results captured by hooks before processing the next event
    yield* drainHookResults(state);
    if ((yield* streamEvent(state, msg)) === 'stop') break;
  }

  // Drain any remaining tool results after the stream ends
  yield* drainHookResults(state);
  yield* settleStream(state);
}

function* drainHookResults(state: StreamState): Generator<MessageChunk> {
  for (const update of state.toolResultQueue.splice(0)) {
    if (state.openToolIds.delete(update.toolCallId)) yield update;
    else getLog().debug({ toolCallId: update.toolCallId }, 'claude.tool_result_not_open');
  }
}

function* streamEvent(state: StreamState, msg: unknown): Generator<MessageChunk, StreamStep> {
  switch ((msg as { type: string }).type) {
    case 'assistant':
      yield* streamAssistant(state, msg as AssistantMessage);
      return 'next';
    case 'user':
      yield* streamToolResults(
        state,
        (msg as { message?: { content?: unknown } }).message?.content
      );
      return 'next';
    case 'system':
      return yield* streamSystem(state, msg as SystemMessage);
    case 'rate_limit_event': {
      const rateLimitMsg = msg as { rate_limit_info?: SDKRateLimitInfo };
      getLog().warn({ rateLimitInfo: rateLimitMsg.rate_limit_info }, 'claude.rate_limit_event');
      state.lastRateLimit = rateLimitMsg.rate_limit_info;
      // The turn is waiting, not stalled: keep the idle watchdog from firing.
      yield { type: 'heartbeat' };
      return 'next';
    }
    case 'result':
      return yield* streamResult(state, msg as SDKResultMessage);
    default:
      return 'next';
  }
}

// ─── Assistant and user messages ─────────────────────────────────────────

function* streamAssistant(state: StreamState, message: AssistantMessage): Generator<MessageChunk> {
  const content = message.message.content;

  // API-level failure surfaced as text (#1797): the SDK writes the error
  // prose into a synthesized assistant message instead of throwing. Both
  // signals are required — a REAL model message can carry an error code
  // too (e.g. 'max_output_tokens' on truncated output) and its content
  // must flow through untouched; only '<synthetic>' content is
  // SDK-generated error prose, never model output.
  if (message.error !== undefined && message.message.model === '<synthetic>') {
    const text = content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n');
    state.pendingSdkError = { code: message.error, text };
    getLog().warn({ errorCode: message.error, text }, 'claude.synthetic_error_message');
    // Withhold the error prose from the output stream — yielding it is
    // what poisons downstream $node.output. If the terminal result
    // contradicts (no is_error), the text is yielded late as a fail-safe.
    return;
  }

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      yield { type: 'agent_message_chunk', text: block.text };
    } else if (block.type === 'thinking' && block.thinking) {
      yield { type: 'agent_thought_chunk', text: block.thinking };
    } else if (block.type === 'tool_use' && block.name && block.id) {
      state.openToolIds.add(block.id);
      yield toolCallEvent(block.id, block.name, block.input);
    }
  }
}

function toolCallEvent(
  id: string,
  name: string,
  input: Record<string, unknown> | undefined
): ProviderEvent {
  const command = name === 'Bash' ? bashCommand(input) : undefined;
  return {
    type: 'tool_call',
    toolCallId: id,
    name,
    ...(command !== undefined ? { title: command } : {}),
    rawInput: toolCallSchema.shape.rawInput.parse(input === undefined ? {} : input),
  };
}

function bashCommand(input: Record<string, unknown> | undefined): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined;
  return typeof input.command === 'string' ? input.command : undefined;
}

function* streamToolResults(state: StreamState, content: unknown): Generator<MessageChunk> {
  for (const block of Array.isArray(content) ? (content as ToolResultBlock[]) : []) {
    if (block.type !== 'tool_result' || !state.openToolIds.delete(block.tool_use_id)) continue;
    yield {
      type: 'tool_call_update',
      toolCallId: block.tool_use_id,
      status: block.is_error === true ? 'failed' : 'completed',
      ...truncateToolOutput(toolResultText(block.content)),
    };
  }
}

/** The text of a `tool_result` block's content. */
function toolResultText(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text)
    .join('\n');
}

// ─── System frames ───────────────────────────────────────────────────────

/** A handler reports `unhandled` when its frame lacks the field it reads. */
type SystemStep = StreamStep | 'unhandled';

function* streamSystem(
  state: StreamState,
  msg: SystemMessage
): Generator<MessageChunk, StreamStep> {
  const step = yield* streamSystemSubtype(state, msg);
  if (step !== 'unhandled') return step;
  getLog().debug({ subtype: msg.subtype }, 'claude.system_message_unhandled');
  return 'next';
}

function* streamSystemSubtype(
  state: StreamState,
  msg: SystemMessage
): Generator<MessageChunk, SystemStep> {
  switch (msg.subtype) {
    case 'session_state_changed':
      return yield* streamSessionState(state, msg);
    case 'background_tasks_changed':
      yield* streamBackgroundTasks(state, msg as unknown as SDKBackgroundTasksChangedMessage);
      return 'next';
    case 'init':
      return yield* streamMcpServerStatus(msg);
    case 'status':
      if (msg.status !== 'compacting') return 'unhandled';
      yield { type: 'compaction', phase: 'started' };
      return 'next';
    case 'compact_boundary':
      return yield* streamCompactBoundary(msg);
    case 'task_started':
      return yield* withTaskId(msg, task => streamTaskStarted(state, task));
    case 'task_progress':
      return yield* withTaskId(msg, task => streamTaskProgress(state, task));
    case 'task_notification':
      return yield* withTaskId(msg, task => streamTaskNotification(state, task));
    case 'hook_started':
    case 'hook_response':
      return yield* streamHook(msg);
    case 'api_retry':
      // The SDK retries the model call itself; Archon only reports it, so a turn that
      // waits out a rate limit does not look stuck.
      yield { type: 'warning', ...apiRetryWarning(msg as unknown as SDKAPIRetryMessage) };
      return 'next';
    default:
      return 'unhandled';
  }
}

function* streamSessionState(
  state: StreamState,
  msg: SystemMessage
): Generator<MessageChunk, StreamStep> {
  // Idle can precede background completion. Only a subsequent idle with no
  // observed work can close streaming input without killing those tasks.
  if (
    msg.state === 'idle' &&
    state.resultSeen &&
    state.liveBackgroundIds.size === 0 &&
    state.visibleTaskIds.size === 0
  ) {
    state.idleReached = true;
    state.closeInput();
    return 'stop';
  }
  if (msg.state === 'running') state.resultSeen = false;
  getLog().debug(
    { state: msg.state, resultSeen: state.resultSeen },
    'claude.session_state_changed'
  );
  if (msg.state === 'running' || msg.state === 'requires_action') {
    yield { type: 'state_update', state: msg.state };
  }
  return 'next';
}

function* streamBackgroundTasks(
  state: StreamState,
  { tasks }: SDKBackgroundTasksChangedMessage
): Generator<MessageChunk> {
  state.liveBackgroundIds = new Set(tasks.filter(task => !task.ambient).map(task => task.task_id));
  state.backgroundObserved ||= state.liveBackgroundIds.size > 0;
  for (const task of tasks) {
    if (task.ambient) {
      state.hiddenTaskIds.add(task.task_id);
      continue;
    }
    if (state.visibleTaskIds.has(task.task_id)) continue;
    state.visibleTaskIds.add(task.task_id);
    yield {
      type: 'subtask',
      taskId: task.task_id,
      status: 'started',
      description: task.description,
      taskType: task.task_type,
    };
  }
}

function* streamMcpServerStatus(msg: SystemMessage): Generator<MessageChunk, SystemStep> {
  if (!msg.mcp_servers) return 'unhandled';
  for (const server of msg.mcp_servers) {
    const status: ProviderEvent = {
      type: 'mcp_server_status',
      server: server.name,
      status: server.status === 'needs-auth' ? 'needs_auth' : server.status,
    };
    if (server.error !== undefined) status.error = server.error;
    yield status;
  }
  return 'next';
}

function* streamCompactBoundary(msg: SystemMessage): Generator<MessageChunk, SystemStep> {
  const meta = msg.compact_metadata;
  if (!meta) return 'unhandled';
  const compaction: ProviderEvent = {
    type: 'compaction',
    phase: 'completed',
    trigger: meta.trigger,
    tokensBefore: meta.pre_tokens,
  };
  if (meta.post_tokens !== undefined) compaction.tokensAfter = meta.post_tokens;
  yield compaction;
  return 'next';
}

function* withTaskId(
  msg: SystemMessage,
  handle: (task: TaskMessage) => Generator<MessageChunk>
): Generator<MessageChunk, SystemStep> {
  if (!msg.task_id) return 'unhandled';
  yield* handle(msg as TaskMessage);
  return 'next';
}

function* streamTaskStarted(state: StreamState, msg: TaskMessage): Generator<MessageChunk> {
  // Ambient / housekeeping tasks (SDK v0.3.247+ signals them directly;
  // older emitters use skip_transcript) are SDK-internal — they bloat
  // the Web UI's tasks panel without telling
  // the user anything actionable. Drop them at the provider boundary;
  // the workflow executor and SSE bridge never see them.
  if (msg.ambient === true || msg.skip_transcript === true) {
    state.hiddenTaskIds.add(msg.task_id);
    getLog().debug(
      { taskId: msg.task_id, taskType: msg.task_type },
      'claude.task_started_housekeeping_suppressed'
    );
    return;
  }
  const started: ProviderEvent = {
    type: 'subtask',
    taskId: msg.task_id,
    status: 'started',
  };
  if (msg.description !== undefined) started.description = msg.description;
  if (msg.task_type !== undefined) started.taskType = msg.task_type;
  if (msg.tool_use_id !== undefined) started.parentToolCallId = msg.tool_use_id;
  state.visibleTaskIds.add(msg.task_id);
  state.backgroundObserved = true;
  yield started;
}

function* streamTaskProgress(state: StreamState, msg: TaskMessage): Generator<MessageChunk> {
  if (state.hiddenTaskIds.has(msg.task_id)) {
    // The SDK emits task_progress roughly every 30s to prove the
    // subprocess is alive. Preserve that idle-watchdog signal without
    // recreating the hidden task in persistence or the Web UI.
    yield { type: 'heartbeat' };
    return;
  }
  state.visibleTaskIds.add(msg.task_id);
  state.backgroundObserved = true;
  const progress: ProviderEvent = {
    type: 'subtask',
    taskId: msg.task_id,
    status: 'running',
  };
  if (msg.description !== undefined) progress.description = msg.description;
  if (msg.summary !== undefined) progress.summary = msg.summary;
  if (msg.usage !== undefined) progress.usage = msg.usage;
  if (msg.last_tool_name !== undefined) progress.lastToolName = msg.last_tool_name;
  if (msg.tool_use_id !== undefined) progress.parentToolCallId = msg.tool_use_id;
  yield progress;
}

function* streamTaskNotification(state: StreamState, msg: TaskMessage): Generator<MessageChunk> {
  const announced = state.visibleTaskIds.has(msg.task_id);
  if (
    !announced &&
    (state.hiddenTaskIds.has(msg.task_id) || msg.ambient === true || msg.skip_transcript === true)
  ) {
    getLog().debug(
      { taskId: msg.task_id, taskType: msg.task_type },
      'claude.task_notification_housekeeping_suppressed'
    );
    return;
  }
  const status = msg.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'stopped') {
    throw new Error(
      `Claude task ${msg.task_id} reported unknown terminal status: ${String(status)}`
    );
  }
  state.visibleTaskIds.delete(msg.task_id);
  const ended: ProviderEvent = {
    type: 'subtask',
    taskId: msg.task_id,
    status,
  };
  if (msg.summary !== undefined) ended.summary = msg.summary;
  if (msg.output_file) ended.outputFile = msg.output_file;
  if (msg.usage !== undefined) ended.usage = msg.usage;
  if (msg.tool_use_id !== undefined) ended.parentToolCallId = msg.tool_use_id;
  yield ended;
}

function* streamHook(msg: SystemMessage): Generator<MessageChunk, SystemStep> {
  if (!msg.hook_id) return 'unhandled';
  const identity = {
    hookId: msg.hook_id,
    hookName: msg.hook_name ?? '',
    hookEvent: msg.hook_event ?? '',
  };
  if (msg.subtype === 'hook_started') {
    yield { type: 'hook', ...identity, status: 'started' };
    return 'next';
  }
  const hook: ProviderEvent = { type: 'hook', ...identity, status: hookStatus(msg.outcome) };
  if (msg.exit_code !== undefined) hook.exitCode = msg.exit_code;
  yield hook;
  return 'next';
}

function hookStatus(outcome: SystemMessage['outcome']): 'succeeded' | 'cancelled' | 'failed' {
  if (outcome === 'success') return 'succeeded';
  if (outcome === 'cancelled') return 'cancelled';
  return 'failed';
}

/** Counts, delay, status and the SDK's error token only: the vendor's error body stays out. */
function apiRetryWarning(retry: SDKAPIRetryMessage): ProviderWarning {
  const delay =
    retry.retry_delay_ms < 1000
      ? `${String(retry.retry_delay_ms)}ms`
      : `${String(Math.round(retry.retry_delay_ms / 1000))}s`;
  const cause =
    retry.error_status === null ? retry.error : `HTTP ${String(retry.error_status)} ${retry.error}`;
  return {
    code: 'claude.api_retry',
    message: `Claude is retrying the model call (attempt ${String(retry.attempt)} of ${String(retry.max_retries)}, waiting ${delay}, ${cause})`,
  };
}

// ─── Result ──────────────────────────────────────────────────────────────

function* streamResult(
  state: StreamState,
  resultMsg: SDKResultMessage
): Generator<MessageChunk, StreamStep> {
  const usage = resultUsage(state, resultMsg);
  // The terminal result resolves any recorded synthetic error message.
  const syntheticError = state.pendingSdkError;
  state.pendingSdkError = undefined;

  // Fail-safe (never observed in practice): a synthetic error message
  // followed by a non-error result. Yield the withheld text late rather
  // than silently swallowing content.
  if (syntheticError !== undefined && !resultMsg.is_error) {
    getLog().warn(
      {
        sessionIdPreview: sessionPreview(resultMsg.session_id),
        errorCode: syntheticError.code,
      },
      'claude.synthetic_error_not_confirmed'
    );
    if (syntheticError.text) yield { type: 'agent_message_chunk', text: syntheticError.text };
  }

  const verdict = judgeResult(resultMsg, syntheticError, state.lastRateLimit);
  logResultVerdict(resultMsg, syntheticError, verdict);
  state.resultSeen = true;
  state.resultReported = true;
  yield resultChunk(resultMsg, usage, verdict, state.queryTokensUnknown);
  // A failed turn is over: nothing after it belongs to this query.
  return verdict.failure === undefined ? 'next' : 'stop';
}

// ─── Stream end ──────────────────────────────────────────────────────────

/**
 * Settle a stream whose events have ended, unless live background work means the
 * stream was cut off rather than finished: that case returns without `settled`, and
 * the engine's unsettled-stream failure names the tasks.
 */
function* settleStream(state: StreamState): Generator<MessageChunk> {
  if (
    state.visibleTaskIds.size > 0 ||
    state.liveBackgroundIds.size > 0 ||
    (state.backgroundObserved && !state.idleReached)
  )
    return;

  // Stream ended after a synthetic error message with no terminal result to
  // confirm or contradict it. A dangling synthetic error is a failure — the
  // SDK ends every turn with a result, so this is an abnormal end (#1797).
  if (state.pendingSdkError !== undefined) {
    getLog().error(
      { errorCode: state.pendingSdkError.code, text: state.pendingSdkError.text },
      'claude.synthetic_error_stream_ended'
    );
    yield failureResultChunk(
      classifyClaudeApiError(
        state.pendingSdkError.code,
        undefined,
        state.lastRateLimit,
        state.pendingSdkError.text || 'API error with no error text'
      )
    );
  } else if (!state.resultReported) {
    getLog().error('claude.stream_ended_without_result');
    const noResult = failureResultChunk(
      failureOf('unknown', 'Claude Code ended the turn without a result')
    );
    noResult.errorSubtype = 'stream_ended_without_result';
    yield noResult;
  }
  yield { type: 'settled' };
}
