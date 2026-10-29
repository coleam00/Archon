/**
 * A JSON-RPC connection to one `codex app-server` process over stdio.
 *
 * The wire is JSON Lines: one message per line, JSON-RPC 2.0 without the `"jsonrpc"`
 * field. Archon sends requests and reads responses by id; the server streams
 * notifications and may send requests of its own. The method and params types come
 * from `./protocol`, generated from the pinned Codex binary
 * (`scripts/generate-codex-protocol.ts`). Users run their own Codex version, so the
 * provider reads only the fields it needs from what arrives.
 */
import type { GetAccountResponse } from './protocol/v2/GetAccountResponse';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter } from 'node:path';
import { createLogger } from '@archon/paths';
import type { ProviderLifecycleEvent } from '@archon/provider-contract';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse';
import { toolResponse } from './native-tools';
import type { ClientRequest } from './protocol/ClientRequest';
import type { ServerNotification } from './protocol/ServerNotification';
import type { ServerRequest } from './protocol/ServerRequest';
import type { CodexBinary } from './binary-resolver';

const TOOL_CALL_METHOD = 'item/tool/call';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex.app-server');
  return cachedLog;
}

/** Process spawner, injectable so tests drive a fake child instead of a real process. */
export type Spawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe'] }
) => ChildProcessWithoutNullStreams;

type Method = ClientRequest['method'];
export type ParamsOf<M extends Method> = Extract<ClientRequest, { method: M }>['params'];

/** A JSON-RPC error response. `code` is the protocol's; the message is Codex's prose. */
export class JsonRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string
  ) {
    super(`${method} failed (JSON-RPC ${String(code)}): ${message}`);
    this.name = 'JsonRpcError';
  }
}

/** How the connection ended. */
export type ConnectionEnd =
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn_failed'; error: NodeJS.ErrnoException };

/**
 * How often an app-server that has not exited yet is reported. There is no deadline: a
 * Codex shutting down on a loaded machine was seen taking several seconds longer each
 * time load rose, then exiting 0, and a deadline turned that slow cleanup into a failed
 * node. Cancelling the run stops the provider plugin, which ends the wait.
 */
const TERM_EXIT_WARN_MS = 30_000;

/** How much raw stderr a connection buffers, and how much of it becomes evidence. */
const STDERR_BUFFER_CHARS = 8000;
const STDERR_EVIDENCE_LINES = 10;
const STDERR_EVIDENCE_CHARS = 1000;

/**
 * Codex asks for a new ChatGPT token after its access token is rejected. Archon mints the
 * token from the user's stored subscription when a run starts, and has no way to mint
 * another mid-turn, so it declines in words the turn's auth failure can carry.
 */
const CHATGPT_TOKEN_REFRESH = 'account/chatgptAuthTokens/refresh' satisfies ServerRequest['method'];
const CHATGPT_TOKEN_REFRESH_DECLINED =
  'Archon cannot refresh the delivered ChatGPT token during a turn';

/**
 * The evidence form of a stderr buffer: credentials redacted, then cut to its last lines.
 * Redacting before cutting keeps a credential that straddles the cut from leaking its
 * tail; the buffer is far larger than the evidence, so a credential cut at the buffer's
 * own start never reaches it.
 */
function stderrEvidence(buffer: string, credentialValues: readonly string[]): string {
  const lines = redactCredentialValues(buffer, credentialValues).trim().split('\n');
  return lines.slice(-STDERR_EVIDENCE_LINES).join('\n').slice(-STDERR_EVIDENCE_CHARS);
}

/** A request that could not complete because the process ended first. */
export class ConnectionClosedError extends Error {
  readonly #stderr: string;

  /**
   * @param beforeFirstResponse the process ended without answering any request.
   * @param stderr the tail of Codex's stderr, already redacted.
   * @param errors the turn's `error` notifications, kept as evidence.
   */
  constructor(
    readonly end: ConnectionEnd,
    readonly beforeFirstResponse: boolean,
    stderr: string,
    errors: readonly string[] = []
  ) {
    super([`Codex app-server ${describeEnd(end)} before the turn completed`, ...errors].join('\n'));
    this.name = 'ConnectionClosedError';
    this.#stderr = stderr;
  }

  /**
   * The message plus Codex's stderr tail, for the operator. Evidence only: nothing
   * classifies from it. Kept off `message` so logging the error does not copy stderr.
   */
  get evidence(): string {
    return this.#stderr ? `${this.message}\nstderr:\n${this.#stderr}` : this.message;
  }
}

function describeEnd(end: ConnectionEnd): string {
  return end.kind === 'spawn_failed'
    ? `could not start: ${end.error.message}`
    : `exited (${end.signal ? `signal ${end.signal}` : `code ${String(end.code)}`})`;
}

/** Whether `promise` settles within `ms`. A rejection counts as settled. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  const settled = promise.then(
    () => true as const,
    () => true as const
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return result;
}

/** The env key that holds PATH: `Path` on Windows when the parent spelled it so. */
function pathKey(env: Record<string, string>): string {
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function parseObjectFrame(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object frame');
  }
  return parsed as Record<string, unknown>;
}

export class AppServerConnection {
  private readonly toolCalls = new Set<Promise<void>>();
  private toolCallHandler: ((params: unknown) => Promise<DynamicToolCallResponse>) | undefined;

  handleToolCalls(handler: (params: unknown) => Promise<DynamicToolCallResponse>): void {
    this.toolCallHandler = handler;
  }

  /** Stop accepting calls and join operations that may already have committed effects. */
  async finishToolCalls(): Promise<void> {
    this.toolCallHandler = undefined;
    await Promise.all(this.toolCalls);
  }

  private nextId = 1;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly queue: ServerNotification[] = [];
  private wake: (() => void) | undefined;
  private endedWith: ConnectionEnd | undefined;
  private responded = false;
  private stderrTail = '';
  /** Credential values from the process env, redacted from its stderr. */
  private readonly credentialValues: readonly string[];
  private readonly endSignal = Promise.withResolvers<ConnectionEnd>();
  /** Resolves once the process is gone, however it ended. */
  readonly ended = this.endSignal.promise;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    env: Record<string, string>,
    protectedEnvKeys?: readonly string[],
    readonly runId?: string
  ) {
    this.credentialValues = collectCredentialValues(env, protectedEnvKeys);
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) this.receive(line);
        newline = buffered.indexOf('\n');
      }
    });
    // Codex logs to stderr. Reading it keeps the pipe from filling and blocking the server,
    // and its tail is the only account of why a process exited early.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_BUFFER_CHARS);
    });
    // A write after the process died fails here; the exit handler reports the end.
    child.stdin.on('error', error => {
      getLog().debug({ err: error }, 'codex.app_server_stdin_error');
    });
    child.stdin.once('finish', () => {
      if (this.runId) getLog().debug({ runId: this.runId }, 'codex.stdin_finished');
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.runId) getLog().debug({ runId: this.runId, code, signal }, 'codex.child_exit');
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.close({ kind: 'spawn_failed', error });
    });
    // 'close', not 'exit': it fires after stdout drained, so the last frames are read first.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.runId) getLog().debug({ runId: this.runId }, 'codex.child_close');
      this.close({ kind: 'exited', code, signal });
    });
  }

  /** Spawns `codex app-server` with the given extra arguments and environment. */
  static start(
    binary: CodexBinary,
    args: string[],
    env: Record<string, string>,
    spawner: Spawner = spawn as unknown as Spawner,
    protectedEnvKeys?: readonly string[],
    runId?: string
  ): AppServerConnection {
    const childEnv = { ...env };
    if (binary.pathDirs.length > 0) {
      const key = pathKey(childEnv);
      childEnv[key] = [...binary.pathDirs, childEnv[key]].filter(Boolean).join(delimiter);
    }
    const child = spawner(binary.path, ['app-server', ...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new AppServerConnection(child, childEnv, protectedEnvKeys, runId);
  }

  /** Sends a request and resolves with its result, or rejects with a {@link JsonRpcError}. */
  request(method: 'account/read', params: ParamsOf<'account/read'>): Promise<GetAccountResponse>;
  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<unknown>;
  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<unknown> {
    if (this.endedWith) return Promise.reject(this.closedError(this.endedWith));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: 'initialized'): void {
    this.send({ method });
  }

  /** The server's notifications in arrival order, ending when the process ends. */
  async *notifications(): AsyncGenerator<ServerNotification> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.endedWith) return;
      await new Promise<void>(resolve => {
        this.wake = resolve;
      });
    }
  }

  /**
   * Ends the process: close stdin, which makes app-server exit, then wait for the exit
   * however long it takes. With `termAfterMs`, a process that has not exited by then is
   * sent SIGTERM. Without it, none is sent: a SIGTERM that lands while Codex is still
   * exiting after stdin closed makes it wait about 40 seconds and exit 1, where it would
   * have exited 0 within seconds. Never SIGKILL: SIGTERM lets Codex stop the commands it
   * started, while SIGKILL orphans them.
   */
  async shutdown(
    termAfterMs?: number,
    warnMs = TERM_EXIT_WARN_MS
  ): Promise<ConnectionEnd | undefined> {
    if (this.endedWith) return this.endedWith;
    this.child.stdin.end();
    if (termAfterMs !== undefined && !(await this.exitsWithin(termAfterMs))) {
      this.child.kill('SIGTERM');
    }
    let waitedMs = 0;
    while (!(await this.exitsWithin(warnMs))) {
      waitedMs += warnMs;
      getLog().warn(
        {
          pid: this.child.pid,
          waitedMs,
          lifecycle: 'process_still_exiting' satisfies ProviderLifecycleEvent,
        },
        'codex.app_server_still_exiting'
      );
    }
    return this.endedWith;
  }

  private exitsWithin(ms: number): Promise<boolean> {
    return settlesWithin(this.ended, ms);
  }

  // Outgoing frames are never logged: the API-key login request carries the key.
  private send(message: object): void {
    if (this.endedWith) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    if (this.endedWith) return;
    let message: Record<string, unknown>;
    try {
      message = parseObjectFrame(line);
    } catch {
      // The line can carry model or user text, so only its length is logged.
      getLog().warn({ bytes: Buffer.byteLength(line) }, 'codex.app_server_unparseable_line');
      return;
    }
    const { id, method } = message;
    if (typeof id === 'number' && typeof method !== 'string') {
      this.receiveResponse(id, message);
      return;
    }
    if (typeof method !== 'string') return;
    if (id !== undefined) {
      this.receiveRequest(id, method, message.params);
      return;
    }
    this.receiveNotification(message);
  }

  private receiveResponse(id: number, message: Record<string, unknown>): void {
    this.responded = true;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    const error = message.error as { code?: unknown; message?: unknown } | undefined;
    if (error) {
      request.reject(
        new JsonRpcError(
          request.method,
          typeof error.code === 'number' ? error.code : 0,
          typeof error.message === 'string' ? error.message : JSON.stringify(error)
        )
      );
    } else {
      request.resolve(message.result);
    }
  }

  private receiveRequest(id: unknown, method: string, params: unknown): void {
    if (method === TOOL_CALL_METHOD && this.toolCallHandler) {
      const handler = this.toolCallHandler;
      const operation = Promise.resolve()
        .then(() => handler(params))
        .then(
          result => this.send({ id, result }),
          (error: unknown) => {
            getLog().error({ err: error }, 'codex.tool_call_failed');
            this.send({
              id,
              result: toolResponse('Archon could not execute the tool call.', false),
            });
          }
        );
      this.toolCalls.add(operation);
      void operation.then(() => this.toolCalls.delete(operation));
      return;
    }
    // A request from Codex: approval, user input, elicitation, token refresh. Archon
    // runs with approvals off and handles none of them, and an unanswered request
    // stalls the turn, so each gets an error reply at once.
    getLog().warn({ method }, 'codex.app_server_request_declined');
    this.send({
      id,
      error:
        method === CHATGPT_TOKEN_REFRESH
          ? // The method exists; Archon only has no newer token than the one it delivered.
            { code: -32000, message: CHATGPT_TOKEN_REFRESH_DECLINED }
          : { code: -32601, message: `Archon does not handle ${method}` },
    });
  }

  private receiveNotification(message: Record<string, unknown>): void {
    this.queue.push(message as unknown as ServerNotification);
    this.wakeReader();
  }

  /** The error for work cut short by `end`, with the turn's `error` notifications. */
  closedError(end: ConnectionEnd, errors: readonly string[] = []): ConnectionClosedError {
    return new ConnectionClosedError(
      end,
      !this.responded,
      stderrEvidence(this.stderrTail, this.credentialValues),
      errors
    );
  }

  private wakeReader(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /** The one place the connection ends: pending requests fail and notifications stop. */
  private close(end: ConnectionEnd): void {
    if (this.endedWith) return;
    this.endedWith = end;
    for (const request of this.pending.values()) request.reject(this.closedError(end));
    this.pending.clear();
    this.wakeReader();
    this.endSignal.resolve(end);
  }
}
