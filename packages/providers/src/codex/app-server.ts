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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '@archon/paths';
import type { ClientRequest } from './protocol/ClientRequest';
import type { ServerNotification } from './protocol/ServerNotification';
import type { CodexBinary } from './binary-resolver';

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

/** A request that could not complete because the process ended first. */
export class ConnectionClosedError extends Error {
  /** @param errors the turn's `error` notifications, kept as evidence. */
  constructor(
    readonly end: ConnectionEnd,
    errors: readonly string[] = []
  ) {
    super([`Codex app-server ${describeEnd(end)} before the turn completed`, ...errors].join('\n'));
    this.name = 'ConnectionClosedError';
  }
}

export function describeEnd(end: ConnectionEnd): string {
  return end.kind === 'spawn_failed'
    ? `could not start: ${end.error.message}`
    : `exited (${end.signal ? `signal ${end.signal}` : `code ${String(end.code)}`})`;
}

/** The env key that holds PATH: `Path` on Windows when the parent spelled it so. */
function pathKey(env: Record<string, string>): string {
  return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}

export class AppServerConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly queue: ServerNotification[] = [];
  private wake: (() => void) | undefined;
  private endedWith: ConnectionEnd | undefined;
  /** Resolves once the process is gone, however it ended. */
  readonly ended: Promise<ConnectionEnd>;
  private markEnded!: (end: ConnectionEnd) => void;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.ended = new Promise(resolve => {
      this.markEnded = resolve;
    });
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
    // Codex logs to stderr; reading it keeps the pipe from filling and blocking the server.
    child.stderr.resume();
    // A write after the process died fails here; the exit handler reports the end.
    child.stdin.on('error', error => {
      getLog().debug({ err: error }, 'codex.app_server_stdin_error');
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.close({ kind: 'spawn_failed', error });
    });
    // 'close', not 'exit': it fires after stdout drained, so the last frames are read first.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.close({ kind: 'exited', code, signal });
    });
  }

  /** Spawns `codex app-server` with the given extra arguments and environment. */
  static start(
    binary: CodexBinary,
    args: string[],
    env: Record<string, string>,
    spawner: Spawner = spawn as unknown as Spawner
  ): AppServerConnection {
    const childEnv = { ...env };
    if (binary.pathDirs.length > 0) {
      const key = pathKey(childEnv);
      childEnv[key] = [...binary.pathDirs, childEnv[key]].filter(Boolean).join(
        process.platform === 'win32' ? ';' : ':'
      );
    }
    const child = spawner(binary.path, ['app-server', ...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new AppServerConnection(child);
  }

  /** Sends a request and resolves with its result, or rejects with a {@link JsonRpcError}. */
  request<M extends Method>(method: M, params: ParamsOf<M>): Promise<unknown> {
    if (this.endedWith) return Promise.reject(new ConnectionClosedError(this.endedWith));
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
   * Ends the process: close stdin, which makes app-server exit, then SIGTERM if it has not
   * exited within `graceMs`. Never SIGKILL: SIGTERM lets Codex stop the commands it
   * started, while SIGKILL orphans them.
   */
  async shutdown(graceMs: number): Promise<void> {
    if (this.endedWith) return;
    this.child.stdin.end();
    if (await this.exitsWithin(graceMs)) return;
    this.child.kill('SIGTERM');
    if (!(await this.exitsWithin(graceMs))) {
      getLog().warn({ pid: this.child.pid }, 'codex.app_server_ignored_sigterm');
    }
  }

  private async exitsWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => {
        resolve(false);
      }, ms);
    });
    const exited = await Promise.race([this.ended.then(() => true as const), timeout]);
    clearTimeout(timer);
    return exited;
  }

  // Outgoing frames are never logged: the API-key login request carries the key.
  private send(message: object): void {
    if (this.endedWith) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      getLog().warn({ line: line.slice(0, 200) }, 'codex.app_server_unparseable_line');
      return;
    }
    const { id, method } = message;
    if (typeof id === 'number' && typeof method !== 'string') {
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
      return;
    }
    if (typeof method !== 'string') return;
    if (id !== undefined) {
      // A request from Codex: approval, user input, elicitation, token refresh. Archon
      // runs with approvals off and handles none of them, and an unanswered request
      // stalls the turn, so each gets an error reply at once.
      getLog().warn({ method }, 'codex.app_server_request_declined');
      this.send({ id, error: { code: -32601, message: `Archon does not handle ${method}` } });
      return;
    }
    this.queue.push(message as unknown as ServerNotification);
    this.wakeReader();
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
    for (const request of this.pending.values()) request.reject(new ConnectionClosedError(end));
    this.pending.clear();
    this.wakeReader();
    this.markEnded(end);
  }
}
