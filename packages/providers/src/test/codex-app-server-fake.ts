/**
 * A scripted stand-in for `codex app-server`, driven through the provider's injectable
 * spawner. It speaks the real JSONL framing over PassThrough streams, so the JSON-RPC
 * client under test is the production one; only the process is fake.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { Spawner } from '../codex/app-server';

type Frame = Record<string, unknown>;

export interface FakeTurnScript {
  /** Notifications sent after `turn/start` answers, in order. */
  notifications?: Frame[];
  /** End the turn with this `turn/completed` status (default `completed`); `null` sends none. */
  completion?: { status: string; error?: Frame | null } | null;
  /** Exit the process with this code after the notifications instead of completing. */
  exitCode?: number;
  /** JSON-RPC errors by method. */
  errors?: Record<string, { code: number; message: string }>;
  /** Fail the spawn itself with this errno code. */
  spawnError?: string;
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
  signals: string[];
  stdinEnded: boolean;
  /** Request methods in the order the client sent them. */
  readonly methods: string[];
}

export const THREAD_ID = 'thread-1';
export const TURN_ID = 'turn-1';

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

    const send = (frame: Frame): void => {
      if (!closed) stdout.write(`${JSON.stringify(frame)}\n`);
    };
    const completeTurn = (status: string, error: Frame | null = null): void => {
      send({
        method: 'turn/completed',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, items: [], status, error } },
      });
    };

    let buffered = '';
    stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        const message = JSON.parse(line) as Frame;
        if (typeof message.method !== 'string' || message.id === undefined) continue;
        const method = message.method;
        record.requests.push({ method, params: message.params as Record<string, unknown> });
        const error = turn.errors?.[method];
        if (error) {
          send({ id: message.id, error });
          continue;
        }
        switch (method) {
          case 'thread/start':
            send({ id: message.id, result: { thread: { id: THREAD_ID } } });
            break;
          case 'thread/resume':
            send({
              id: message.id,
              result: { thread: { id: (message.params as { threadId: string }).threadId } },
            });
            break;
          case 'turn/start':
            send({ id: message.id, result: { turn: { id: TURN_ID, status: 'inProgress' } } });
            for (const frame of turn.notifications ?? []) send(frame);
            if (turn.exitCode !== undefined) {
              close(turn.exitCode, null);
            } else if (turn.completion !== null) {
              const completion = turn.completion ?? { status: 'completed' };
              completeTurn(completion.status, completion.error ?? null);
            }
            break;
          case 'turn/interrupt':
            send({ id: message.id, result: {} });
            completeTurn('interrupted');
            break;
          default:
            send({ id: message.id, result: {} });
        }
      }
    });
    stdin.on('finish', () => {
      record.stdinEnded = true;
      close(0, null);
    });
    return child;
  }) as unknown as Spawner & { processes: FakeProcess[] };
  spawner.processes = processes;
  return spawner;
}

// ─── Notification builders ───────────────────────────────────────────────

export function itemStarted(item: Frame): Frame {
  return { method: 'item/started', params: { item, threadId: THREAD_ID, turnId: TURN_ID } };
}

export function itemCompleted(item: Frame): Frame {
  return { method: 'item/completed', params: { item, threadId: THREAD_ID, turnId: TURN_ID } };
}

export function agentMessage(text: string, id = 'msg-1'): Frame {
  return itemCompleted({ type: 'agentMessage', id, text, phase: null });
}

export function command(
  id: string,
  commandLine: string,
  done?: { status?: string; exitCode?: number | null; output?: string }
): Frame {
  return {
    type: 'commandExecution',
    id,
    command: commandLine,
    status: done?.status ?? (done ? 'completed' : 'inProgress'),
    aggregatedOutput: done?.output ?? null,
    exitCode: done?.exitCode ?? null,
  };
}

export function tokenUsage(
  last: { input: number; output: number; cached?: number; cacheWrite?: number },
  turnId = TURN_ID
): Frame {
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

export function rateLimits(
  primary: { usedPercent: number; resetsAt: number | null } | null,
  secondary: { usedPercent: number; resetsAt: number | null } | null = null
): Frame {
  return {
    method: 'account/rateLimits/updated',
    params: { rateLimits: { limitId: 'codex', primary, secondary } },
  };
}

/** A failed turn's error, as `turn/completed` carries it. */
export function turnError(codexErrorInfo: unknown, message: string): Frame {
  return { message, codexErrorInfo, additionalDetails: null, misalignment: null };
}

export function errorNotification(message: string, willRetry: boolean): Frame {
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
