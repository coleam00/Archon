/**
 * One Codex turn over an initialized app-server connection: open or continue the
 * thread, start the turn, and map its notifications into MessageChunks until the
 * parent turn completes and the background work it started has drained.
 */
import { requireMcpConnections, type McpStatus } from '../mcp/readiness';
import { createLogger } from '@archon/paths';
import { sessionPreview, toolCallSchema, truncateToolOutput } from '@archon/provider-contract';
import {
  mergeTokenUsage,
  type MessageChunk,
  type ProviderEvent,
  type ResultChunk,
  type TokenUsage,
} from '../types';
import { ClassifiedProviderError, failureResult } from '../shared/failure';
import type { AppServerConnection, ParamsOf } from './app-server';
import type { CodexLogin, ThreadParams } from './login';
import { openThread } from './thread';
import { toolResponse, type buildCodexNativeTools } from './native-tools';
import type { ServerNotification } from './protocol/ServerNotification';
import { steered, type TurnIds } from './turn-messages';
import type { McpServerStatusUpdatedNotification } from './protocol/v2/McpServerStatusUpdatedNotification';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage';
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown';
import type { Turn } from './protocol/v2/Turn';
import type { McpServerConnectionStatus } from './protocol/v2/McpServerConnectionStatus';
import type { TurnError } from './protocol/v2/TurnError';
import { declaredServers, readThreadMcpStatuses } from './scope';
import {
  MANAGED_CHATGPT_TOKEN_REJECTED,
  classifyTurnError,
  describeErrorInfo,
  withModelAccessAdvice,
} from './turn-error';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

type ToolCallEvent = Extract<ProviderEvent, { type: 'tool_call' }>;
type ToolCallUpdateEvent = Extract<ProviderEvent, { type: 'tool_call_update' }>;
const TOOL_ITEM_TYPES = [
  'commandExecution',
  'webSearch',
  'mcpToolCall',
  'fileChange',
  'dynamicToolCall',
] as const satisfies readonly ThreadItem['type'][];
type ToolItem = Extract<ThreadItem, { type: (typeof TOOL_ITEM_TYPES)[number] }>;

function isToolItem(item: ThreadItem): item is ToolItem {
  return TOOL_ITEM_TYPES.some(type => type === item.type);
}

/**
 * The `tool_call` for an item that runs a tool. `title` is what the operator reads (the
 * command, the query, `server/tool`); `name` is the kind of tool.
 */
function toolCallOf(item: ToolItem): ToolCallEvent {
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'command_execution',
        title: item.command,
        rawInput: { command: item.command },
      };
    case 'webSearch':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'web_search',
        title: item.query,
        rawInput: { query: item.query },
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: item.tool,
        title: item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
        rawInput: toolCallSchema.shape.rawInput.parse(item.arguments),
      };
    case 'mcpToolCall': {
      const call: ToolCallEvent = {
        type: 'tool_call',
        toolCallId: item.id,
        name: item.tool,
        title: `${item.server}/${item.tool}`,
      };
      if (item.arguments !== undefined) {
        call.rawInput = toolCallSchema.shape.rawInput.parse(item.arguments);
      }
      return call;
    }
    case 'fileChange':
      return {
        type: 'tool_call',
        toolCallId: item.id,
        name: 'file_change',
        rawInput: { changes: item.changes },
      };
  }
}

/** A tool item that ran and failed, or that Codex refused to run. */
function itemFailed(item: ToolItem): boolean {
  if (item.type === 'webSearch') return false;
  if (item.type === 'dynamicToolCall') return item.status === 'failed' || item.success === false;
  if (item.status === 'failed' || item.status === 'declined') return true;
  return item.type === 'commandExecution' && item.exitCode !== null && item.exitCode !== 0;
}

/** The `tool_call_update` that closes a completed tool item. */
function toolCallUpdateOf(item: ToolItem): ToolCallUpdateEvent {
  const update: ToolCallUpdateEvent = {
    type: 'tool_call_update',
    toolCallId: item.id,
    status: itemFailed(item) ? 'failed' : 'completed',
  };
  switch (item.type) {
    case 'commandExecution':
      if (item.exitCode !== null) update.exitCode = item.exitCode;
      return { ...update, ...truncateToolOutput(item.aggregatedOutput ?? '') };
    case 'dynamicToolCall':
      return {
        ...update,
        ...truncateToolOutput(
          (item.contentItems ?? [])
            .filter(item => item.type === 'inputText')
            .map(item => item.text)
            .join('\n')
        ),
      };
    case 'mcpToolCall':
      if (item.status === 'failed') {
        return { ...update, ...truncateToolOutput(item.error?.message ?? 'MCP tool failed') };
      }
      return {
        ...update,
        ...truncateToolOutput(item.result?.content ? JSON.stringify(item.result.content) : ''),
      };
    case 'webSearch':
    case 'fileChange':
      return update;
  }
}

type SubtaskEvent = Extract<ProviderEvent, { type: 'subtask' }>;

function backgroundEventOf(
  item: ThreadItem,
  completed: boolean,
  threadId: string
): SubtaskEvent | undefined {
  if (item.type === 'subAgentActivity') {
    if (item.kind !== 'started' && item.kind !== 'completed') return undefined;
    return {
      type: 'subtask',
      taskId: `agent:${item.agentThreadId}`,
      taskType: 'local_agent',
      description: item.agentPath,
      status: item.kind,
    };
  }
  if (item.type === 'commandExecution' && item.source === 'unifiedExecStartup') {
    const terminalStatuses = {
      inProgress: undefined,
      completed: 'completed',
      failed: 'failed',
      declined: 'stopped',
    } as const;
    const status = completed ? terminalStatuses[item.status] : 'started';
    if (!status) return undefined;
    return {
      type: 'subtask',
      taskId: `command:${threadId}:${item.id}`,
      taskType: 'command_execution',
      description: item.command,
      status,
    };
  }
  return undefined;
}

/**
 * The first and latest usage snapshots one thread reported while the turn observed it, and
 * what it used before its cumulative total last reset (a context overflow resets it).
 */
interface UsageSpan {
  first: ThreadTokenUsage;
  end: TokenUsageBreakdown;
  beforeReset?: TokenUsage;
}

function extendedSpan(span: UsageSpan | undefined, usage: ThreadTokenUsage): UsageSpan {
  if (!span) return { first: usage, end: usage.total };
  // A total below the last one is a reset: what was used so far stays, and counting restarts.
  if (usage.total.inputTokens < span.end.inputTokens)
    return { first: usage, end: usage.total, beforeReset: spanUsageOf(span) };
  return { ...span, end: usage.total };
}

/**
 * A thread's usage over a span: its cumulative total at the end less the total before the
 * span's first request (`total - last` of the first snapshot), clamped at zero, plus what it
 * used before a reset. Codex reports reasoning tokens inside `outputTokens`, so they are not
 * added again.
 */
function spanUsageOf({ first, end, beforeReset }: UsageSpan): TokenUsage {
  const used = (key: keyof TokenUsageBreakdown): number =>
    Math.max(0, end[key] - (first.total[key] - first.last[key]));
  return {
    input: used('inputTokens') + (beforeReset?.input ?? 0),
    output: used('outputTokens') + (beforeReset?.output ?? 0),
    cacheRead: used('cachedInputTokens') + (beforeReset?.cacheRead ?? 0),
    cacheWrite: used('cacheWriteInputTokens') + (beforeReset?.cacheWrite ?? 0),
  };
}

/** The turn's usage: the parent thread's span plus each subagent thread's span. */
function turnUsageOf(observation: TurnObservation): TokenUsage | undefined {
  const spans = [observation.usageSpan, ...observation.agentUsageSpans.values()];
  return mergeTokenUsage(
    spans.filter((span): span is UsageSpan => span !== undefined).map(spanUsageOf)
  );
}

/** A string at `value[key]`, or undefined: responses are read narrowly, not trusted whole. */
function idAt(value: unknown, key: 'thread' | 'turn'): string | undefined {
  const nested =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  const id =
    typeof nested === 'object' && nested !== null ? (nested as { id?: unknown }).id : undefined;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export interface TurnRequest {
  abortSignal: AbortSignal | undefined;
  /** Engine texts to steer into the active turn (`SendQueryOptions.turnMessages`). */
  turnMessages?: AsyncIterable<string>;
  tools: ReturnType<typeof buildCodexNativeTools>;
  connection: AppServerConnection;
  login: CodexLogin | undefined;
  cwd: string;
  resumeSessionId: string | undefined;
  /**
   * Continue `resumeSessionId` in a new thread with its history, leaving it unchanged, so
   * concurrent runs that continue one thread never write into it together.
   */
  forkSession: boolean;
  authoritativeCredential: boolean;
  threadParams: ThreadParams;
  turnParams: Omit<ParamsOf<'turn/start'>, 'threadId'>;
  /**
   * Declared workflow plugins, or an empty list for titles. Undefined for direct chat,
   * which keeps the user's setup. Scoped threads also restrict MCP servers (`./scope`).
   */
  nodePlugins: readonly string[] | undefined;
  hasOutputFormat: boolean;
  model: string | undefined;
  /** Receives the thread id as soon as it exists, so a failure can still carry it. */
  onThread: (threadId: string) => void;
  /** Receives the turn id as soon as it exists, so cancel can interrupt it. */
  onTurn: (turnId: string) => void;
  /** Receives the context window Codex reports for the turn's model. */
  onContextWindow: (tokens: number) => void;
}

/** What the notifications of one turn have shown so far. */
interface TurnObservation {
  /** Read by the host tool handler too: a tool call after completion is refused. */
  parentCompleted: boolean;
  readonly startedToolIds: Set<string>;
  readonly liveTasks: Set<string>;
  readonly agentThreads: Set<string>;
  /** Threads spawned by Codex's v1 tool, which reports no subagent lifecycle of its own. */
  readonly v1Threads: Set<string>;
  /**
   * What other threads reported before a spawn could name them: Codex starts a child, and
   * delivers its thread's notifications, before the parent's spawn item or activity arrives.
   */
  readonly otherThreads: Map<string, OtherThread>;
  pendingFailure: ResultChunk | undefined;
  /** What the turn's result reported, so a later result carries only what followed. */
  reported: Pick<ResultChunk, 'tokens' | 'structuredOutput'> | undefined;
  readonly errors: string[];
  lastAgentMessage: string;
  // `last` is one request and is re-sent unchanged with later snapshots, so the turn's usage
  // is the change in the thread's `total`. A resumed thread's total already includes earlier
  // turns and is not replayed before the turn starts, so the first snapshot sets the baseline.
  // If that first snapshot is a re-send rather than a request (a local compaction or a
  // usage-limit failure before the first request), a resumed turn over-counts by one earlier
  // request; Codex sends no pre-turn total on this resume path to correct it.
  usageSpan: UsageSpan | undefined;
  // Codex reports a subagent's usage on its own thread, so each subagent this turn saw start
  // gets a span, across all of its turns. A span starts at the thread's first snapshot because
  // a forked subagent, the default for `spawn_agent`, starts from its parent's running total.
  // A v2 `subAgentActivity` start or a completed v1 `spawnAgent` item marks a thread a subagent.
  readonly agentUsageSpans: Map<string, UsageSpan>;
  rateLimits: RateLimitSnapshot | undefined;
  retries: number;
}

const MCP_READINESS = {
  notStarted: 'pending',
  starting: 'pending',
  connected: 'connected',
  authenticationRequired: 'needs_auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
} as const satisfies Record<McpServerConnectionStatus, McpStatus['status']>;

async function readDeclaredMcpStatuses(
  connection: AppServerConnection,
  threadId: string,
  declared: readonly string[]
): Promise<McpStatus[]> {
  const statuses = await readThreadMcpStatuses(connection, threadId);
  return statuses
    .filter(server => declared.includes(server.name))
    .map(server => {
      if (server.runtimeStatus === null) {
        throw new ClassifiedProviderError(
          'misconfigured',
          `Cannot establish connection readiness for MCP server "${server.name}": unknown runtime status`
        );
      }
      return {
        type: 'mcp_server_status',
        server: server.name,
        status: MCP_READINESS[server.runtimeStatus],
        ...(server.toolsError !== null ? { error: server.toolsError } : {}),
      };
    });
}

/**
 * Keeps observing background work after the parent completes.
 * Lost observation is thrown for `sendQuery` to classify; it never settles.
 */
export async function* streamTurn(request: TurnRequest): AsyncGenerator<MessageChunk> {
  const { connection } = request;
  const { threadId, instructionSources } = await openThread(request);
  getLog().debug(
    {
      sessionIdPreview: sessionPreview(threadId),
      resumed: !!request.resumeSessionId,
      forked: !!request.resumeSessionId && request.forkSession,
    },
    'codex.thread_ready'
  );
  yield { type: 'session', sessionId: threadId };
  yield instructionSources === undefined
    ? {
        type: 'warning',
        code: 'codex.instruction_sources_unavailable',
        message: 'Codex did not report valid loaded instruction sources.',
      }
    : { type: 'heartbeat', instructionSources };
  const declared = Object.keys(declaredServers(request.threadParams.config ?? {}));
  yield* requireMcpConnections(
    declared,
    () => readDeclaredMcpStatuses(connection, threadId, declared),
    request.abortSignal
  );
  const observation: TurnObservation = {
    parentCompleted: false,
    startedToolIds: new Set(),
    liveTasks: new Set(),
    agentThreads: new Set(),
    v1Threads: new Set(),
    otherThreads: new Map(),
    pendingFailure: undefined,
    reported: undefined,
    errors: [],
    lastAgentMessage: '',
    usageSpan: undefined,
    agentUsageSpans: new Map(),
    rateLimits: undefined,
    retries: 0,
  };
  const turnId = await startTurn(request, threadId, observation);
  const ids = { threadId, turnId };

  for await (const next of steered(connection, ids, request.turnMessages)) {
    if (!('method' in next)) yield next;
    else yield* observeNotification(request, ids, observation, next);
    // While observed work remains live, starts on this parent turn and recognized
    // descendant threads are still accepted after parent completion. No live work ends
    // observation; it does not establish that Codex cannot report another start later.
    if (observation.parentCompleted && !hasLiveWork(observation)) {
      yield* remainingResult(ids, observation);
      return;
    }
  }
  yield* remainingResult(ids, observation);
  throw connection.closedError(await connection.ended, observation.errors);
}

/**
 * Another thread's turns, kept from its first notification, and its items and usage, held until
 * a spawn makes it a subagent and then observed in order. One thread's notifications arrive in
 * order; across threads Codex gives no order.
 */
interface OtherThread {
  readonly runningTurns: Set<string>;
  turnCompleted: boolean;
  readonly held: HeldNotification[];
}

type HeldNotification = Extract<
  ServerNotification,
  { method: 'item/started' | 'item/completed' | 'thread/tokenUsage/updated' }
>;

/** Holds a notification from a thread that is neither the parent nor a known subagent. */
function heldForLater(ids: TurnIds, observation: TurnObservation, n: HeldNotification): boolean {
  const { threadId } = n.params;
  if (threadId === ids.threadId || observation.agentThreads.has(threadId)) return false;
  otherThreadOf(observation, threadId).held.push(n);
  return true;
}

function otherThreadOf(observation: TurnObservation, threadId: string): OtherThread {
  let thread = observation.otherThreads.get(threadId);
  if (!thread) {
    thread = { runningTurns: new Set(), turnCompleted: false, held: [] };
    observation.otherThreads.set(threadId, thread);
  }
  return thread;
}

/**
 * A v2 subagent is live until its `subAgentActivity` completes. A v1 subagent has no such
 * signal. A v1 spawn submits the child's first input, so a v1 subagent is live until a turn
 * on its thread has completed, and again while a later one runs. A `sendInput` holds nothing:
 * Codex completes its item before reporting whether the input was submitted, so a failed
 * submission would hold the node until cancellation. A turn it starts after observation has
 * ended is not counted; one it starts while other live work holds observation open is.
 */
function hasLiveWork(observation: TurnObservation): boolean {
  if (observation.liveTasks.size > 0) return true;
  for (const threadId of observation.v1Threads) {
    const thread = observation.otherThreads.get(threadId);
    if (!thread?.turnCompleted || thread.runningTurns.size > 0) return true;
  }
  return false;
}

/**
 * The result owed once observation ends: the held failure with all of the turn's usage, or a
 * later result with the usage reported since the sent one. The engine sums the results' tokens
 * and takes each one's structured output, so the later result repeats it.
 */
function* remainingResult(ids: TurnIds, observation: TurnObservation): Generator<ResultChunk> {
  const usage = turnUsageOf(observation);
  if (observation.pendingFailure) {
    if (usage) observation.pendingFailure.tokens = usage;
    yield observation.pendingFailure;
    return;
  }
  const { reported } = observation;
  const tokens = reported && usage && usageAfter(reported.tokens, usage);
  if (!tokens) return;
  const { structuredOutput } = reported;
  yield { type: 'result', sessionId: ids.threadId, tokens, structuredOutput };
}

/** What `usage` holds beyond `reported`, axis by axis, or undefined when nothing grew. */
function usageAfter(reported: TokenUsage | undefined, usage: TokenUsage): TokenUsage | undefined {
  const later: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
    later[key] = Math.max(0, (usage[key] ?? 0) - (reported?.[key] ?? 0));
  return Object.values(later).some(Boolean) ? later : undefined;
}

/** Serve host tool calls for the turn, then start it. */
async function startTurn(
  request: TurnRequest,
  threadId: string,
  observation: TurnObservation
): Promise<string> {
  const { connection, tools } = request;
  // Codex can request a tool before turn/start's response has reached the caller.
  const activeTurn = Promise.withResolvers<string | undefined>();
  connection.handleToolCalls(async params => {
    const turnId = await activeTurn.promise;
    return !observation.parentCompleted && !request.abortSignal?.aborted
      ? tools.call(params, threadId, turnId)
      : toolResponse('The Archon turn has ended.', false);
  });
  let turnId: string | undefined;
  try {
    const turnResponse = await connection.request('turn/start', {
      threadId,
      ...request.turnParams,
    });
    turnId = idAt(turnResponse, 'turn');
    if (!turnId) throw new Error('Codex app-server returned a turn without an id');
  } finally {
    activeTurn.resolve(turnId);
  }
  request.onTurn(turnId);
  return turnId;
}

async function* observeNotification(
  request: TurnRequest,
  ids: TurnIds,
  observation: TurnObservation,
  notification: ServerNotification
): AsyncGenerator<MessageChunk> {
  switch (notification.method) {
    case 'account/rateLimits/updated':
      observation.rateLimits = notification.params.rateLimits;
      return;

    case 'thread/tokenUsage/updated':
      if (heldForLater(ids, observation, notification)) return;
      observeTokenUsage(request, ids, observation, notification.params);
      return;

    case 'error':
      yield* observeError(observation, notification.params);
      return;

    case 'item/started':
    case 'item/completed':
      if (heldForLater(ids, observation, notification)) return;
      yield* observeItem(
        ids,
        observation,
        notification.params,
        notification.method === 'item/completed'
      );
      return;

    case 'mcpServer/startupStatus/updated':
      // Startup runs at thread start, before the turn; a null thread id is a
      // connection-wide server.
      if (notification.params.threadId === ids.threadId || notification.params.threadId === null) {
        yield mcpServerStatusOf(notification.params);
      }
      return;

    case 'turn/started':
      if (notification.params.threadId !== ids.threadId)
        otherThreadOf(observation, notification.params.threadId).runningTurns.add(
          notification.params.turn.id
        );
      return;

    case 'turn/completed':
      if (notification.params.threadId !== ids.threadId) {
        const thread = otherThreadOf(observation, notification.params.threadId);
        thread.runningTurns.delete(notification.params.turn.id);
        thread.turnCompleted = true;
        return;
      }
      yield* observeTurnCompleted(request, ids, observation, notification.params);
      return;

    default:
      return;
  }
}

type NotificationParams<M extends ServerNotification['method']> = Extract<
  ServerNotification,
  { method: M }
>['params'];

function observeTokenUsage(
  request: TurnRequest,
  ids: TurnIds,
  observation: TurnObservation,
  params: NotificationParams<'thread/tokenUsage/updated'>
): void {
  if (params.threadId === ids.threadId) {
    // Usage reported for another turn of the thread is not this turn's.
    if (params.turnId !== ids.turnId) return;
    const contextWindow = params.tokenUsage.modelContextWindow;
    if (contextWindow !== null) request.onContextWindow(contextWindow);
    observation.usageSpan = extendedSpan(observation.usageSpan, params.tokenUsage);
    return;
  }
  observeSubagentUsage(observation, params);
}

function observeSubagentUsage(
  observation: TurnObservation,
  params: NotificationParams<'thread/tokenUsage/updated'>
): void {
  if (!observation.agentThreads.has(params.threadId)) return;
  const span = observation.agentUsageSpans.get(params.threadId);
  observation.agentUsageSpans.set(params.threadId, extendedSpan(span, params.tokenUsage));
}

/**
 * `willRetry` errors are Codex reconnecting on its own; the turn's outcome is decided by
 * `turn/completed`. They are kept as evidence for a turn that never completes.
 */
function* observeError(
  observation: TurnObservation,
  { error, willRetry }: NotificationParams<'error'>
): Generator<MessageChunk> {
  getLog().debug(
    { willRetry, codexErrorInfo: error.codexErrorInfo },
    'codex.turn_error_notification'
  );
  observation.errors.push(error.message);
  if (!willRetry) return;
  // Reported so a turn that waits out a reconnect does not look stuck. The count
  // is Archon's: the notification carries no attempt number outside its prose.
  observation.retries += 1;
  const cause = describeErrorInfo(error.codexErrorInfo);
  yield {
    type: 'warning',
    code: 'codex.will_retry',
    message: `Codex is retrying the model call (retry ${String(observation.retries)} this turn${cause ? `, ${cause}` : ''})`,
  };
}

function* observeItem(
  ids: TurnIds,
  observation: TurnObservation,
  {
    item,
    threadId: itemThreadId,
    turnId: itemTurnId,
  }: NotificationParams<'item/started' | 'item/completed'>,
  completed: boolean
): Generator<MessageChunk> {
  const parentItem = itemThreadId === ids.threadId && itemTurnId === ids.turnId;
  if (!parentItem && !observation.agentThreads.has(itemThreadId)) return;
  yield* observeV1Spawn(ids, observation, item, completed);
  // Unified exec is a process lifecycle, not a foreground tool call: its end may
  // arrive after the result, which closes foreground tool calls in the contract.
  if (
    item.type === 'subAgentActivity' ||
    (item.type === 'commandExecution' && item.source === 'unifiedExecStartup')
  ) {
    yield* observeBackgroundItem(ids, observation, item, completed, itemThreadId);
    return;
  }
  if (!parentItem) return;
  if (isToolItem(item)) {
    yield* observeToolItem(observation, item, completed);
  } else if (completed && item.type === 'agentMessage' && item.text) {
    observation.lastAgentMessage = item.text;
    yield { type: 'agent_message_chunk', text: item.text };
  } else if (completed && item.type === 'reasoning') {
    const text = item.summary.join('\n\n');
    if (text) yield { type: 'agent_thought_chunk', text };
  }
}

/** Codex's v1 spawn tool reports no `subAgentActivity`; its completed item names the thread. */
function* observeV1Spawn(
  ids: TurnIds,
  observation: TurnObservation,
  item: ThreadItem,
  completed: boolean
): Generator<MessageChunk> {
  if (!completed || item.type !== 'collabAgentToolCall' || item.tool !== 'spawnAgent') return;
  for (const threadId of item.receiverThreadIds) {
    yield* registerSubagent(ids, observation, threadId, true);
  }
}

/** Makes a thread a subagent, then observes what it reported before, in its own order. */
function* registerSubagent(
  ids: TurnIds,
  observation: TurnObservation,
  threadId: string,
  v1: boolean
): Generator<MessageChunk> {
  if (observation.agentThreads.has(threadId)) return;
  observation.agentThreads.add(threadId);
  if (v1) observation.v1Threads.add(threadId);
  for (const held of observation.otherThreads.get(threadId)?.held.splice(0) ?? []) {
    if (held.method === 'thread/tokenUsage/updated') observeSubagentUsage(observation, held.params);
    else yield* observeItem(ids, observation, held.params, held.method === 'item/completed');
  }
}

function* observeBackgroundItem(
  ids: TurnIds,
  observation: TurnObservation,
  item: ThreadItem,
  completed: boolean,
  itemThreadId: string
): Generator<MessageChunk> {
  const event = backgroundEventOf(item, completed, itemThreadId);
  if (!event) return;
  if (event.status === 'started') {
    if (observation.liveTasks.has(event.taskId)) return;
    observation.liveTasks.add(event.taskId);
    yield event;
    if (item.type === 'subAgentActivity') {
      yield* registerSubagent(ids, observation, item.agentThreadId, false);
    }
    return;
  }
  if (!observation.liveTasks.delete(event.taskId)) return;
  yield event;
}

function* observeToolItem(
  observation: TurnObservation,
  item: ToolItem,
  completed: boolean
): Generator<MessageChunk> {
  if (!observation.startedToolIds.has(item.id)) {
    observation.startedToolIds.add(item.id);
    yield toolCallOf(item);
  }
  if (!completed) return;
  if (item.type === 'mcpToolCall' && item.status === 'failed') {
    getLog().warn(
      { server: item.server, tool: item.tool, error: item.error, itemId: item.id },
      'mcp_tool_call_failed'
    );
  }
  yield toolCallUpdateOf(item);
}

async function* observeTurnCompleted(
  request: TurnRequest,
  ids: TurnIds,
  observation: TurnObservation,
  { turn, threadId: completedThreadId }: NotificationParams<'turn/completed'>
): AsyncGenerator<MessageChunk> {
  if (completedThreadId !== ids.threadId || turn.id !== ids.turnId || observation.parentCompleted)
    return;
  observation.parentCompleted = true;
  await request.connection.finishToolCalls();
  const usage = turnUsageOf(observation);
  for (const chunk of completeTurn(turn.status, turn.error, request, {
    threadId: ids.threadId,
    usage,
    rateLimits: observation.rateLimits,
    lastAgentMessage: observation.lastAgentMessage,
  })) {
    // The executor stops reading on failure results, so live work must drain first.
    if (chunk.type === 'result' && chunk.failure) observation.pendingFailure = chunk;
    else yield chunk;
    if (chunk.type !== 'result') continue;
    observation.reported = { tokens: usage, structuredOutput: chunk.structuredOutput };
  }
}

function mcpServerStatusOf(
  params: McpServerStatusUpdatedNotification
): Extract<MessageChunk, { type: 'mcp_server_status' }> {
  const status = {
    starting: 'pending',
    ready: 'connected',
    failed: params.failureReason === 'reauthenticationRequired' ? 'needs_auth' : 'failed',
    // A cancelled startup leaves the server unavailable to the turn.
    cancelled: 'failed',
  } as const satisfies Record<
    McpServerStatusUpdatedNotification['status'],
    Extract<MessageChunk, { type: 'mcp_server_status' }>['status']
  >;
  return {
    type: 'mcp_server_status',
    server: params.name,
    status: status[params.status],
    ...(params.error !== null ? { error: params.error } : {}),
  };
}

function* completeTurn(
  status: Turn['status'],
  error: TurnError | null,
  request: TurnRequest,
  state: {
    threadId: string;
    usage: TokenUsage | undefined;
    rateLimits: RateLimitSnapshot | undefined;
    lastAgentMessage: string;
  }
): Generator<MessageChunk> {
  let result: ResultChunk;
  if (status === 'completed') {
    result = yield* completedResult(request.hasOutputFormat, state.lastAgentMessage);
  } else if (status === 'failed' && error) {
    result = failedResult(error, request, state.rateLimits);
  } else {
    // An interrupt Archon did not send, or a failed status with no error attached.
    getLog().error({ status }, 'codex.turn_ended_without_completion');
    result = failureResult('unknown', 'codex_turn_failed', `Codex turn ended ${status}`);
  }
  result.sessionId = state.threadId;
  if (state.usage) result.tokens = state.usage;
  // Reaching a turn means `thread/resume` or `thread/fork` succeeded.
  if (request.resumeSessionId) result.resumed = true;
  yield result;
}

function* completedResult(
  hasOutputFormat: boolean,
  lastAgentMessage: string
): Generator<MessageChunk, ResultChunk> {
  const result: ResultChunk = { type: 'result' };
  if (!hasOutputFormat || !lastAgentMessage) return result;
  // Codex returns structured output as the final message's text. Parse it onto
  // structuredOutput so the dag-executor handles all providers uniformly.
  try {
    result.structuredOutput = JSON.parse(lastAgentMessage);
  } catch {
    getLog().warn(
      { outputPreview: lastAgentMessage.slice(0, 200) },
      'codex.structured_output_not_json'
    );
    yield {
      type: 'warning',
      code: 'codex.structured_output_not_json',
      message:
        'Structured output requested but Codex returned non-JSON text. ' +
        'Downstream $nodeId.output.field references may not evaluate correctly.',
    };
  }
  return result;
}

function failedResult(
  error: TurnError,
  request: TurnRequest,
  rateLimits: RateLimitSnapshot | undefined
): ResultChunk {
  const { failureClass, resetAt } = classifyTurnError(error.codexErrorInfo, rateLimits);
  const vendorText = [error.message, error.additionalDetails].filter(Boolean).join('\n');
  getLog().error({ failureClass, codexErrorInfo: error.codexErrorInfo }, 'codex.turn_failed');
  const evidence = withModelAccessAdvice(vendorText, request.model);
  const result = failureResult(
    failureClass,
    'codex_turn_failed',
    failureClass === 'auth' && request.login?.type === 'chatgptAuthTokens'
      ? `${MANAGED_CHATGPT_TOKEN_REJECTED}\n\n${evidence}`
      : evidence
  );
  if (resetAt && result.failure) result.failure.resetAt = resetAt;
  return result;
}
