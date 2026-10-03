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
import type { InitializeResponse } from '../codex/protocol/InitializeResponse';
import type { ServerNotification } from '../codex/protocol/ServerNotification';
import type { CodexErrorInfo } from '../codex/protocol/v2/CodexErrorInfo';
import type { FileUpdateChange } from '../codex/protocol/v2/FileUpdateChange';
import type { McpToolCallStatus } from '../codex/protocol/v2/McpToolCallStatus';
import type { RateLimitWindow } from '../codex/protocol/v2/RateLimitWindow';
import type { Thread } from '../codex/protocol/v2/Thread';
import type { ThreadItem } from '../codex/protocol/v2/ThreadItem';
import type { ThreadResumeResponse } from '../codex/protocol/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from '../codex/protocol/v2/ThreadStartResponse';
import type { Turn } from '../codex/protocol/v2/Turn';
import type { TurnError } from '../codex/protocol/v2/TurnError';
import type { TurnInterruptResponse } from '../codex/protocol/v2/TurnInterruptResponse';
import type { TurnStartResponse } from '../codex/protocol/v2/TurnStartResponse';
import type { TurnStatus } from '../codex/protocol/v2/TurnStatus';

type CommandExecution = Extract<ThreadItem, { type: 'commandExecution' }>;
type McpToolCall = Extract<ThreadItem, { type: 'mcpToolCall' }>;

export interface FakeTurnScript {
  /** Notifications sent after `turn/start` answers, in order. */
  notifications?: ServerNotification[];
  /** End the turn with this `turn/completed` status (default `completed`); `null` sends none. */
  completion?: { status: TurnStatus; error?: TurnError | null } | null;
  /** Exit the process with this code after the notifications instead of completing. */
  exitCode?: number;
  /** Exit with this code and stderr as soon as the process starts, before any response. */
  startupFailure?: { code: number; stderr: string };
  /** JSON-RPC errors by method. */
  errors?: Record<string, { code: number; message: string }>;
  /** Fail the spawn itself with this errno code. */
  spawnError?: string;
  /** Never answer `turn/interrupt`, as a wedged Codex would not. */
  ignoreInterrupt?: boolean;
  /** Keep running when stdin closes; only a signal ends the process. */
  ignoreStdinClose?: boolean;
}

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
      const { code, stderr: text } = turn.startupFailure;
      setImmediate(() => {
        stderr.write(text);
        close(code, null);
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
        const { method, id } = message;
        if (id === undefined) {
          record.notifications.push(method);
          if (method === 'initialized') initialized = true;
          continue;
        }
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
          default:
            send({ id, result: {} });
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

export function tokenUsage(
  last: { input: number; output: number; cached?: number; cacheWrite?: number },
  turnId = TURN_ID
): ServerNotification {
  const breakdown = {
    totalTokens: last.input + last.output,
    inputTokens: last.input,
    cachedInputTokens: last.cached ?? 0,
    cacheWriteInputTokens: last.cacheWrite ?? 0,
    outputTokens: last.output,
    reasoningOutputTokens: 0,
  };
  return {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: THREAD_ID,
      turnId,
      tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null },
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

export function errorNotification(message: string, willRetry: boolean): ServerNotification {
  return {
    method: 'error',
    params: {
      error: turnError(null, message),
      willRetry,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    },
  };
}
