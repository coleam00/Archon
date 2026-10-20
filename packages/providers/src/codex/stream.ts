/**
 * One Codex turn over an initialized app-server connection: open or continue the
 * thread, start the turn, and map its notifications into MessageChunks until the
 * parent turn completes and the background work it started has drained.
 */
import { requireMcpConnections, type McpStatus } from '../mcp/readiness';
import { BUNDLED_VERSION, createLogger } from '@archon/paths';
import { sessionPreview, toolCallSchema, truncateToolOutput } from '@archon/provider-contract';
import type { MessageChunk, ProviderEvent, ResultChunk, TokenUsage } from '../types';
import { ClassifiedProviderError, failureResult } from '../shared/failure';
import type { AppServerConnection, ParamsOf } from './app-server';
import { withDeliveredCredentialConfig, type CodexLogin, type ThreadParams } from './login';
import { toolResponse, type buildCodexNativeTools } from './native-tools';
import type { ServerNotification } from './protocol/ServerNotification';
import type { McpServerStatusUpdatedNotification } from './protocol/v2/McpServerStatusUpdatedNotification';
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot';
import type { ThreadItem } from './protocol/v2/ThreadItem';
import type { ThreadTokenUsage } from './protocol/v2/ThreadTokenUsage';
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown';
import type { Turn } from './protocol/v2/Turn';
import type { TurnError } from './protocol/v2/TurnError';
import {
  applyNodeScope,
  checkThreadMcpScope,
  declaredServers,
  readCodexInventory,
  readThreadMcpStatuses,
} from './scope';
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
 * The turn's usage: the thread's cumulative total at the end less the total before the
 * turn's first request (`total - last` of the turn's first snapshot), clamped at zero as
 * Codex clamps its own per-turn figure (a context overflow resets the total). Codex reports
 * reasoning tokens inside `outputTokens`, so they are not added again.
 */
function turnUsageOf(first: ThreadTokenUsage, end: TokenUsageBreakdown): TokenUsage {
  const used = (key: keyof TokenUsageBreakdown): number =>
    Math.max(0, end[key] - (first.total[key] - first.last[key]));
  return {
    input: used('inputTokens'),
    output: used('outputTokens'),
    cacheRead: used('cachedInputTokens'),
    cacheWrite: used('cacheWriteInputTokens'),
  };
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

/** The Codex home the app-server reports in its `initialize` response, for error messages. */
function codexHomeOf(initializeResponse: unknown): string {
  const home =
    typeof initializeResponse === 'object' && initializeResponse !== null
      ? (initializeResponse as { codexHome?: unknown }).codexHome
      : undefined;
  return typeof home === 'string' && home.length > 0 ? home : 'the Codex home';
}

export interface TurnRequest {
  requireMcpConnections?: true;
  abortSignal: AbortSignal | undefined;
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
}

/** The ids of the parent thread and turn this stream observes. */
interface TurnIds {
  threadId: string;
  turnId: string;
}

/** What the notifications of one turn have shown so far. */
interface TurnObservation {
  /** Read by the host tool handler too: a tool call after completion is refused. */
  parentCompleted: boolean;
  readonly startedToolIds: Set<string>;
  readonly liveTasks: Set<string>;
  readonly agentThreads: Set<string>;
  pendingFailure: ResultChunk | undefined;
  readonly errors: string[];
  lastAgentMessage: string;
  // `last` is one request and is re-sent unchanged with later snapshots, so the turn's usage
  // is the change in the thread's `total`. A resumed thread's total already includes earlier
  // turns and is not replayed before the turn starts, so the first snapshot sets the baseline.
  // If that first snapshot is a re-send rather than a request (a local compaction or a
  // usage-limit failure before the first request), a resumed turn over-counts by one earlier
  // request; Codex sends no pre-turn total on this resume path to correct it.
  usageSpan: { first: ThreadTokenUsage; end: TokenUsageBreakdown } | undefined;
  rateLimits: RateLimitSnapshot | undefined;
  retries: number;
}

/**
 * Keeps observing background work after the parent completes.
 * Lost observation is thrown for `sendQuery` to classify; it never settles.
 */
export async function* streamTurn(request: TurnRequest): AsyncGenerator<MessageChunk> {
  const { connection } = request;
  const threadId = await openThread(request);
  if (request.requireMcpConnections) {
    const names = Object.keys(declaredServers(request.threadParams.config ?? {}));
    yield* requireMcpConnections(
      names,
      async () =>
        (await readThreadMcpStatuses(connection, threadId))
          .filter(server => names.includes(server.name))
          .map(server => {
            const states = {
              notStarted: 'pending',
              starting: 'pending',
              connected: 'connected',
              authenticationRequired: 'needs_auth',
              failed: 'failed',
              cancelled: 'failed',
              disabled: 'disabled',
            } as const satisfies Record<
              NonNullable<typeof server.runtimeStatus>,
              McpStatus['status']
            >;
            if (server.runtimeStatus === null) {
              throw new ClassifiedProviderError(
                'misconfigured',
                `Cannot establish connection readiness for MCP server "${server.name}": unknown runtime status`
              );
            }
            return {
              type: 'mcp_server_status' as const,
              server: server.name,
              status: states[server.runtimeStatus],
              ...(server.toolsError !== null ? { error: server.toolsError } : {}),
            };
          }),
      request.abortSignal
    );
  }
  const observation: TurnObservation = {
    parentCompleted: false,
    startedToolIds: new Set(),
    liveTasks: new Set(),
    agentThreads: new Set(),
    pendingFailure: undefined,
    errors: [],
    lastAgentMessage: '',
    usageSpan: undefined,
    rateLimits: undefined,
    retries: 0,
  };
  const turnId = await startTurn(request, threadId, observation);
  const ids = { threadId, turnId };

  for await (const notification of connection.notifications()) {
    yield* observeNotification(request, ids, observation, notification);
    // While observed work remains live, starts on this parent turn and recognized
    // descendant threads are still accepted after parent completion. An empty set ends
    // observation; it does not establish that Codex cannot report another start later.
    if (observation.parentCompleted && observation.liveTasks.size === 0) {
      if (observation.pendingFailure) yield observation.pendingFailure;
      return;
    }
  }
  if (observation.pendingFailure) yield observation.pendingFailure;
  throw connection.closedError(await connection.ended, observation.errors);
}

/**
 * Initialize the connection, log in, and start, continue or fork the thread with the
 * request's config, scoped to the node's plugins and MCP servers when it declares them.
 */
async function openThread(request: TurnRequest): Promise<string> {
  const { connection, nodePlugins, login, tools } = request;
  const initialized = await connection.request('initialize', {
    clientInfo: { name: 'archon', title: 'Archon', version: BUNDLED_VERSION },
    // Host tools and external ChatGPT tokens both require Codex's experimental API.
    capabilities:
      tools.specs.length || login?.type === 'chatgptAuthTokens'
        ? { experimentalApi: true, requestAttestation: false }
        : null,
  });
  connection.notify('initialized');
  if (login) {
    // The credential stays in this process's memory: the app-server was started with the
    // ephemeral credential store, so nothing reaches the user's CODEX_HOME.
    await connection.request('account/login/start', login);
  }

  let { threadParams } = request;
  if (request.authoritativeCredential) {
    threadParams = await withDeliveredCredentialConfig(connection, request.cwd, threadParams);
  }
  let declared: string[] | undefined;
  if (nodePlugins) {
    const inventory = await readCodexInventory(connection, {
      cwd: request.cwd,
      plugins: nodePlugins,
      codexHome: codexHomeOf(initialized),
    });
    const scope = applyNodeScope(threadParams.config ?? {}, inventory, nodePlugins);
    threadParams = { ...threadParams, config: scope.config };
    declared = scope.declared;
  }
  // A resumed or forked thread needs the same config: Codex does not store it with the
  // thread, and a fork without it loads the user's MCP servers and plugins again.
  const threadResponse = request.resumeSessionId
    ? await connection.request(request.forkSession ? 'thread/fork' : 'thread/resume', {
        threadId: request.resumeSessionId,
        cwd: request.cwd,
        ...threadParams,
        excludeTurns: true,
      })
    : await connection.request('thread/start', {
        cwd: request.cwd,
        ...threadParams,
        ...(tools.specs.length ? { dynamicTools: tools.specs } : {}),
      });
  const threadId = idAt(threadResponse, 'thread');
  if (!threadId) throw new Error('Codex app-server returned a thread without an id');
  request.onThread(threadId);
  if (declared) await checkThreadMcpScope(connection, threadId, declared);
  getLog().debug(
    {
      sessionIdPreview: sessionPreview(threadId),
      resumed: !!request.resumeSessionId,
      forked: !!request.resumeSessionId && request.forkSession,
    },
    'codex.thread_ready'
  );
  return threadId;
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

    case 'thread/tokenUsage/updated': {
      // Usage reported for another turn of the thread is not this turn's.
      const { params } = notification;
      if (params.threadId === ids.threadId && params.turnId === ids.turnId) {
        observation.usageSpan = {
          first: observation.usageSpan?.first ?? params.tokenUsage,
          end: params.tokenUsage.total,
        };
      }
      return;
    }

    case 'error':
      yield* observeError(observation, notification.params);
      return;

    case 'item/started':
    case 'item/completed':
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

    case 'turn/completed':
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
  // Unified exec is a process lifecycle, not a foreground tool call: its end may
  // arrive after the result, which closes foreground tool calls in the contract.
  if (
    item.type === 'subAgentActivity' ||
    (item.type === 'commandExecution' && item.source === 'unifiedExecStartup')
  ) {
    yield* observeBackgroundItem(observation, item, completed, itemThreadId);
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

function* observeBackgroundItem(
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
    if (item.type === 'subAgentActivity') observation.agentThreads.add(item.agentThreadId);
  } else if (!observation.liveTasks.delete(event.taskId)) return;
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
  const { usageSpan } = observation;
  for (const chunk of completeTurn(turn.status, turn.error, request, {
    threadId: ids.threadId,
    usage: usageSpan && turnUsageOf(usageSpan.first, usageSpan.end),
    rateLimits: observation.rateLimits,
    lastAgentMessage: observation.lastAgentMessage,
  })) {
    // The executor stops reading on failure results, so live work must drain first.
    if (chunk.type === 'result' && chunk.failure) observation.pendingFailure = chunk;
    else yield chunk;
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
