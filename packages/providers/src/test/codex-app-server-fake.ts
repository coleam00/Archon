import type { GetAccountResponse } from '../codex/protocol/v2/GetAccountResponse';
/**
 * A scripted stand-in for `codex app-server`, driven through the provider's injectable
 * spawner. It speaks the real JSONL framing over PassThrough streams, so the JSON-RPC
 * client under test is the production one; only the process is fake.
 *
 * Every frame it sends is typed with the protocol generated from the pinned Codex, so a
 * regeneration that renames or adds a field fails type-check here.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { Spawner } from '../codex/app-server';
import type { ClientRequest } from '../codex/protocol/ClientRequest';
import type { InitializeResponse } from '../codex/protocol/InitializeResponse';
import type { ServerNotification } from '../codex/protocol/ServerNotification';
import type { CodexErrorInfo } from '../codex/protocol/v2/CodexErrorInfo';
import type { ConfigReadResponse } from '../codex/protocol/v2/ConfigReadResponse';
import type { ListMcpServerStatusResponse } from '../codex/protocol/v2/ListMcpServerStatusResponse';
import type { McpServerStatus } from '../codex/protocol/v2/McpServerStatus';
import type { PluginInstalledResponse } from '../codex/protocol/v2/PluginInstalledResponse';
import type { PluginReadResponse } from '../codex/protocol/v2/PluginReadResponse';
import type { PluginSummary } from '../codex/protocol/v2/PluginSummary';
import type { FileUpdateChange } from '../codex/protocol/v2/FileUpdateChange';
import type { LoginAccountResponse } from '../codex/protocol/v2/LoginAccountResponse';
import type { McpToolCallStatus } from '../codex/protocol/v2/McpToolCallStatus';
import type { RateLimitWindow } from '../codex/protocol/v2/RateLimitWindow';
import type { Thread } from '../codex/protocol/v2/Thread';
import type { ThreadItem } from '../codex/protocol/v2/ThreadItem';
import type { ThreadResumeResponse } from '../codex/protocol/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from '../codex/protocol/v2/ThreadStartResponse';
import type { TokenUsageBreakdown } from '../codex/protocol/v2/TokenUsageBreakdown';
import type { Turn } from '../codex/protocol/v2/Turn';
import type { TurnError } from '../codex/protocol/v2/TurnError';
import type { TurnInterruptResponse } from '../codex/protocol/v2/TurnInterruptResponse';
import type { TurnStartResponse } from '../codex/protocol/v2/TurnStartResponse';
import type { TurnStatus } from '../codex/protocol/v2/TurnStatus';

/** A request method, from the generated protocol: a renamed method fails type-check here. */
type Method = ClientRequest['method'];

type CommandExecution = Extract<ThreadItem, { type: 'commandExecution' }>;
type McpToolCall = Extract<ThreadItem, { type: 'mcpToolCall' }>;

export interface FakeTurnScript {
  account?: GetAccountResponse['account'];
  ignoreAccountRead?: boolean;
  /** Notifications sent after `turn/start` answers, in order. */
  notifications?: ServerNotification[];
  /** End the turn with this `turn/completed` status (default `completed`); `null` sends none. */
  completion?: { status: TurnStatus; error?: TurnError | null } | null;
  /** Exit the process with this code after the notifications instead of completing. */
  exitCode?: number;
  /**
   * End the process as soon as it starts, before any response: exit with `code`, or be
   * killed by `signal`.
   */
  startupFailure?: { code: number; stderr: string } | { signal: NodeJS.Signals; stderr: string };
  /** JSON-RPC errors by method. */
  errors?: Partial<Record<Method, { code: number; message: string }>>;
  /** Fail the spawn itself with this errno code. */
  spawnError?: string;
  /** Never answer `turn/interrupt`, as a wedged Codex would not. */
  ignoreInterrupt?: boolean;
  /** Keep running when stdin closes; only a signal ends the process. */
  ignoreStdinClose?: boolean;
  /** MCP server names the user's config defines, as `config/read` reports them. */
  configuredServers?: string[];
  /** Installed plugins in one local marketplace: id (`name@fixture`) to its MCP server names. */
  installedPlugins?: Record<string, string[]>;
  /** `mcpServerStatus/list` pages for the thread, in order (default: one empty page). */
  mcpStatusPages?: ServerStatus[][];
}

/** The `mcpServerStatus/list` fields a test sets; the rest are filled in. */
export type ServerStatus = Pick<McpServerStatus, 'name' | 'pluginId' | 'runtimeStatus'>;

export interface FakeRequest {
  method: string;
  params: Record<string, unknown>;
}

export interface FakeProcess {
  args: string[];
  env: Record<string, string>;
  binary: string;
  requests: FakeRequest[];
  /** Notification methods the client sent. */
  notifications: string[];
  signals: string[];
  stdinEnded: boolean;
  /** Request methods in the order the client sent them. */
  readonly methods: string[];
}

export const THREAD_ID = 'thread-1';
export const TURN_ID = 'turn-1';

/** What the fake sends: a response, an error response, or a notification. */
type OutgoingFrame =
  | { id: number | string; result: unknown }
  | { id: number | string; error: { code: number; message: string } }
  | ServerNotification;

export function createFakeAppServer(script: () => FakeTurnScript = () => ({})): Spawner & {
  processes: FakeProcess[];
} {
  const processes: FakeProcess[] = [];
  const spawner = ((
    command: string,
    args: string[],
    options: { env: Record<string, string> }
  ): ChildProcessWithoutNullStreams => {
    const turn = script();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const record: FakeProcess = {
      args,
      env: options.env,
      binary: command,
      requests: [],
      notifications: [],
      signals: [],
      stdinEnded: false,
      get methods() {
        return this.requests.map(request => request.method);
      },
    };
    processes.push(record);
    let closed = false;
    const close = (code: number | null, signal: string | null): void => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: 4242,
      kill: (signal: string = 'SIGTERM') => {
        record.signals.push(signal);
        close(null, signal);
        return true;
      },
    });

    if (turn.spawnError) {
      const code = turn.spawnError;
      setImmediate(() => {
        child.emit('error', Object.assign(new Error(`spawn ${command} ${code}`), { code }));
        closed = true;
        child.emit('close', -2, null);
      });
      return child;
    }
    if (turn.startupFailure) {
      const failure = turn.startupFailure;
      setImmediate(() => {
        stderr.write(failure.stderr);
        if ('signal' in failure) close(null, failure.signal);
        else close(failure.code, null);
      });
      return child;
    }

    const send = (frame: OutgoingFrame): void => {
      if (!closed) stdout.write(`${JSON.stringify(frame)}\n`);
    };
    const completeTurn = (status: TurnStatus, error: TurnError | null = null): void => {
      send(turnCompleted(status, error));
    };

    // Like the real server, nothing but `initialize` is served before the client
    // acknowledges with the `initialized` notification.
    let initialized = false;
    let buffered = '';
    stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
        if (typeof message.method !== 'string') continue;
        if (message.id === undefined) {
          record.notifications.push(message.method);
          if (message.method === 'initialized') initialized = true;
          continue;
        }
        const id = message.id;
        // The cast types the cases below; a method outside the union reaches `default`.
        const method = message.method as Method;
        record.requests.push({ method, params: message.params as Record<string, unknown> });
        if (method !== 'initialize' && !initialized) {
          send({ id, error: { code: -32600, message: 'Not initialized' } });
          continue;
        }
        const error = turn.errors?.[method];
        if (error) {
          send({ id, error });
          continue;
        }
        switch (method) {
          case 'initialize':
            send({ id, result: initializeResponse() });
            break;
          case 'thread/start':
            send({ id, result: threadStartResponse(THREAD_ID) });
            break;
          case 'thread/resume':
            send({
              id,
              result: threadResumeResponse((message.params as { threadId: string }).threadId),
            });
            break;
          case 'turn/start':
            send({ id, result: { turn: turnOf('inProgress', null) } satisfies TurnStartResponse });
            for (const frame of turn.notifications ?? []) send(frame);
            if (turn.exitCode !== undefined) {
              close(turn.exitCode, null);
            } else if (turn.completion !== null) {
              const completion = turn.completion ?? { status: 'completed' };
              completeTurn(completion.status, completion.error ?? null);
            }
            break;
          case 'turn/interrupt':
            if (turn.ignoreInterrupt) break;
            send({ id, result: {} satisfies TurnInterruptResponse });
            completeTurn('interrupted');
            break;
          case 'account/read':
            if (!turn.ignoreAccountRead)
              send({
                id,
                result: {
                  account: turn.account ?? null,
                  requiresOpenaiAuth: true,
                } satisfies GetAccountResponse,
              });
            break;
          case 'account/login/start':
            send({ id, result: { type: 'apiKey' } satisfies LoginAccountResponse });
            break;
          case 'config/read':
            send({ id, result: configReadResponse(turn.configuredServers ?? []) });
            break;
          case 'plugin/installed':
            send({ id, result: pluginInstalledResponse(turn.installedPlugins ?? {}) });
            break;
          case 'plugin/read': {
            const { pluginName } = message.params as { pluginName: string };
            const servers = turn.installedPlugins?.[`${pluginName}@fixture`] ?? [];
            send({ id, result: pluginReadResponse(pluginName, servers) });
            break;
          }
          case 'mcpServerStatus/list': {
            const pages = turn.mcpStatusPages ?? [[]];
            const { cursor } = message.params as { cursor?: string | null };
            const index = cursor ? Number(cursor) : 0;
            send({ id, result: mcpStatusResponse(pages, index) });
            break;
          }
          default:
            // What Codex answers for a method it does not serve. The fake serves only what
            // the provider sends, so a new request fails the test until it is scripted here.
            send({
              id,
              error: { code: -32600, message: `Invalid request: unknown variant \`${method}\`` },
            });
        }
      }
    });
    stdin.on('finish', () => {
      record.stdinEnded = true;
      if (!turn.ignoreStdinClose) close(0, null);
    });
    return child;
  }) as unknown as Spawner & { processes: FakeProcess[] };
  spawner.processes = processes;
  return spawner;
}

// ─── Response builders ───────────────────────────────────────────────────

function initializeResponse(): InitializeResponse {
  return {
    userAgent: 'codex-fake/0.0.0',
    codexHome: '/home/user/.codex',
    platformFamily: 'unix',
    platformOs: 'linux',
  };
}

function threadOf(id: string): Thread {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: null,
    reasoningEffort: null,
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status: { type: 'idle' },
    path: null,
    cwd: '/workspace',
    cliVersion: '0.0.0',
    originator: null,
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function threadStartResponse(id: string): ThreadStartResponse {
  return {
    thread: threadOf(id),
    model: 'gpt-fake',
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: '/workspace',
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    reasoningEffort: null,
  };
}

function threadResumeResponse(id: string): ThreadResumeResponse {
  return {
    ...threadStartResponse(id),
    collaborationMode: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

function configReadResponse(servers: string[]): ConfigReadResponse {
  return {
    config: {
      model: null,
      review_model: null,
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: null,
      model_provider: null,
      approval_policy: null,
      approvals_reviewer: null,
      sandbox_mode: null,
      sandbox_workspace_write: null,
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      web_search: null,
      tools: null,
      instructions: null,
      developer_instructions: null,
      compact_prompt: null,
      model_reasoning_effort: null,
      model_reasoning_summary: null,
      model_verbosity: null,
      service_tier: null,
      analytics: null,
      browser_use: null,
      computer_use: null,
      desktop: null,
      mcp_servers: Object.fromEntries(servers.map(name => [name, { command: name }])),
    },
    origins: {},
    layers: null,
  };
}

const FAKE_MARKETPLACE_PATH = '/home/user/.codex/marketplaces/fixture/marketplace.json';

function pluginSummary(id: string): PluginSummary {
  return {
    id,
    remotePluginId: null,
    version: null,
    localVersion: null,
    name: id.split('@')[0],
    shareContext: null,
    source: { type: 'local', path: '/home/user/.codex/plugins/fixture' },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: 'AVAILABLE',
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: 'ON_INSTALL',
    availability: 'AVAILABLE',
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: null,
    keywords: [],
  };
}

function pluginInstalledResponse(plugins: Record<string, string[]>): PluginInstalledResponse {
  return {
    marketplaces: [
      {
        name: 'fixture',
        path: FAKE_MARKETPLACE_PATH,
        interface: null,
        plugins: Object.keys(plugins).map(pluginSummary),
      },
    ],
    marketplaceLoadErrors: [],
  };
}

function pluginReadResponse(name: string, mcpServers: string[]): PluginReadResponse {
  return {
    plugin: {
      marketplaceName: 'fixture',
      marketplacePath: FAKE_MARKETPLACE_PATH,
      summary: pluginSummary(`${name}@fixture`),
      shareUrl: null,
      description: null,
      skills: [],
      onboardingSkill: null,
      hooks: [],
      apps: [],
      appTemplates: [],
      mcpServers,
      scheduledTasks: null,
    },
  };
}

function mcpStatusResponse(pages: ServerStatus[][], index: number): ListMcpServerStatusResponse {
  return {
    data: (pages[index] ?? []).map(server => ({
      ...server,
      httpOrigin: null,
      serverInfo: null,
      serverCapabilities: null,
      tools: {},
      toolsError: null,
      resources: [],
      resourceTemplates: [],
      authStatus: 'unsupported',
    })),
    nextCursor: index + 1 < pages.length ? String(index + 1) : null,
  };
}

function turnOf(status: TurnStatus, error: TurnError | null, id = TURN_ID): Turn {
  return {
    id,
    items: [],
    itemsView: 'notLoaded',
    status,
    error,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

// ─── Notification builders ───────────────────────────────────────────────

/** `turn/completed`; pass another `turnId` to replay an earlier turn's completion. */
export function turnCompleted(
  status: TurnStatus,
  error: TurnError | null = null,
  turnId = TURN_ID
): ServerNotification {
  return {
    method: 'turn/completed',
    params: { threadId: THREAD_ID, turn: turnOf(status, error, turnId) },
  };
}

export function itemStarted(item: ThreadItem): ServerNotification {
  return {
    method: 'item/started',
    params: { item, threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 0 },
  };
}

export function itemCompleted(item: ThreadItem): ServerNotification {
  return {
    method: 'item/completed',
    params: { item, threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 0 },
  };
}

export function agentMessage(text: string, id = 'msg-1'): ServerNotification {
  return itemCompleted({
    type: 'agentMessage',
    id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  });
}

export function command(
  id: string,
  commandLine: string,
  done?: { status?: CommandExecution['status']; exitCode?: number | null; output?: string }
): CommandExecution {
  return {
    type: 'commandExecution',
    id,
    pluginId: null,
    scriptPath: null,
    command: commandLine,
    cwd: '/workspace',
    processId: null,
    source: 'agent',
    status: done?.status ?? (done ? 'completed' : 'inProgress'),
    commandActions: [],
    aggregatedOutput: done?.output ?? null,
    exitCode: done?.exitCode ?? null,
    durationMs: null,
  };
}

export function webSearch(id: string, query: string): ThreadItem {
  return { type: 'webSearch', id, query, action: null, results: null };
}

export function mcpToolCall(
  id: string,
  server: string,
  tool: string,
  status: McpToolCallStatus,
  args: Record<string, string>,
  error: string | null = null
): McpToolCall {
  return {
    type: 'mcpToolCall',
    id,
    server,
    tool,
    status,
    arguments: args,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result: null,
    error: error === null ? null : { message: error },
    durationMs: null,
  };
}

export function fileChange(id: string, changes: FileUpdateChange[]): ThreadItem {
  return { type: 'fileChange', id, changes, status: 'completed' };
}

export function reasoning(id: string, summary: string[], content: string[] = []): ThreadItem {
  return { type: 'reasoning', id, summary, content };
}

export function plan(id: string, text: string): ThreadItem {
  return { type: 'plan', id, text };
}

interface Usage {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
}

function breakdownOf(usage: Usage): TokenUsageBreakdown {
  return {
    totalTokens: usage.input + usage.output,
    inputTokens: usage.input,
    cachedInputTokens: usage.cached ?? 0,
    cacheWriteInputTokens: usage.cacheWrite ?? 0,
    outputTokens: usage.output,
    reasoningOutputTokens: 0,
  };
}

/**
 * A usage snapshot: `total` is the thread's cumulative usage, `last` the most recent
 * request's. They are equal for the first request of a new thread.
 */
export function tokenUsage(
  total: Usage,
  last: Usage = total,
  turnId = TURN_ID
): ServerNotification {
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: THREAD_ID,
      turnId,
      tokenUsage: { total: breakdownOf(total), last: breakdownOf(last), modelContextWindow: null },
    },
  };
}

type Window = Pick<RateLimitWindow, 'usedPercent' | 'resetsAt'>;

export function rateLimits(
  primary: Window | null,
  secondary: Window | null = null
): ServerNotification {
  const windowOf = (window: Window | null): RateLimitWindow | null =>
    window && { ...window, windowDurationMins: null };
  return {
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        normalModelSlug: null,
        primary: windowOf(primary),
        secondary: windowOf(secondary),
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: null,
        rateLimitReachedType: null,
      },
    },
  };
}

/** A failed turn's error, as `turn/completed` carries it. */
export function turnError(codexErrorInfo: CodexErrorInfo | null, message: string): TurnError {
  return { message, codexErrorInfo, additionalDetails: null, misalignment: null };
}

export function errorNotification(
  message: string,
  willRetry: boolean,
  codexErrorInfo: CodexErrorInfo | null = null
): ServerNotification {
  return {
    method: 'error',
    params: {
      error: turnError(codexErrorInfo, message),
      willRetry,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    },
  };
}
