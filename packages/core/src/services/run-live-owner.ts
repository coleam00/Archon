import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Idle lifetime for a connection that has not completed an owner handshake. */
export const RUN_LIVE_OWNER_IPC_TIMEOUT_MS = 2_000;

const WATCH_REQUEST = 'watch\n';
const WATCH_READY = 'watching\n';
const OWNER_ATTENTION = 'attention\n';
const CONTROL_HANDOFF = 'control_handoff\n';
const STOP_REQUEST = 'stop\n';
const TERMINATE_REQUEST = 'terminate\n';
const TERMINATE_READY = 'ready\n';
const TERMINATION_LEASE_MS = 8_000;
const OWNER_CLOSE_WAIT_MS = TERMINATION_LEASE_MS + RUN_LIVE_OWNER_IPC_TIMEOUT_MS;
export const RUN_LIVE_OWNER_CONTROL_HANDOFF_GRACE_MS = OWNER_CLOSE_WAIT_MS;
const STARTUP_RECHECK_MS = 50;
const MAX_MESSAGE_BYTES = 256;

export interface RunLiveOwnerOptions {
  /** Enables the detached CLI's active-stop lease. Other owners only publish liveness. */
  detachedProcessPid?: number;
}

export interface RunLiveOwner {
  /** Ring attached waiters, close the endpoint, and release its exact-run lock. */
  close(): Promise<void>;
  /** True only while a detached controller holds a stop lease. */
  isStopRequested(): boolean;
}

export type RunLiveOwnerWatchEvent = 'attention' | 'control_handoff' | 'disconnected';

export interface RunLiveOwnerWatch {
  unsubscribe(): void;
}

export interface RunLiveOwnerStopLease {
  readonly pid: number;
  /** Commit the lease before the caller starts terminating the process tree. */
  commit(): Promise<void>;
  release(): void;
  isLive(): boolean;
}

type StopResponse = { kind: 'unsupported' } | { kind: 'detached'; pid: number };

export class RunLiveOwnerStopUnavailableError extends Error {
  constructor(
    readonly runId: string,
    readonly detail: string
  ) {
    super(`Run ${runId} has no live detached owner: ${detail}`);
    this.name = 'RunLiveOwnerStopUnavailableError';
  }
}

function endpointToken(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

function ownerDirectory(): string {
  const uid = process.getuid?.();
  const directory =
    process.platform === 'win32'
      ? join(tmpdir(), 'archon-run-control')
      : `/tmp/archon-${uid === undefined ? 'user' : String(uid)}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Run live-owner path is not a directory: ${directory}`);
    }
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`Run live-owner directory is owned by another user: ${directory}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Run live-owner directory must have mode 0700: ${directory}`);
    }
  }
  return directory;
}

/** A bounded, user-scoped endpoint: Unix socket on POSIX, named pipe on Windows. */
export function runLiveOwnerPath(runId: string): string {
  const token = endpointToken(runId);
  if (process.platform === 'win32') return `\\\\.\\pipe\\archon-workflow-${token}`;
  return join(ownerDirectory(), `${token}.sock`);
}

function runLiveOwnerLockPath(runId: string): string {
  return join(ownerDirectory(), `${endpointToken(runId)}.lock`);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

/** Reachability probe used by stale-path recovery and integration tests. */
export function canConnectToRunLiveOwner(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket();
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(RUN_LIVE_OWNER_IPC_TIMEOUT_MS, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.connect(path);
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function listenWithoutReplacingOwner(server: Server, path: string): Promise<void> {
  try {
    await listen(server, path);
    return;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EADDRINUSE' || process.platform === 'win32') {
      throw error;
    }
  }

  if (await canConnectToRunLiveOwner(path)) {
    throw new Error(`Run live-owner endpoint is already owned: ${path}`);
  }

  // A crashed Unix owner can leave a socket pathname behind. Refusal, not age,
  // proves that no process owns it.
  rmSync(path, { force: true });
  await listen(server, path);
}

async function acquireOwnerLock(runId: string, endpointPath: string): Promise<number> {
  const lockPath = runLiveOwnerLockPath(runId);
  try {
    return openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }

  if (await canConnectToRunLiveOwner(endpointPath)) {
    throw new Error(`Run live-owner endpoint is already owned: ${endpointPath}`);
  }
  // The lock is created immediately before listen. Give that startup window one
  // chance to become reachable before treating both paths as crash residue.
  await new Promise<void>(resolve => setTimeout(resolve, STARTUP_RECHECK_MS));
  if (await canConnectToRunLiveOwner(endpointPath)) {
    throw new Error(`Run live-owner endpoint is already owned: ${endpointPath}`);
  }

  rmSync(lockPath, { force: true });
  if (process.platform !== 'win32') rmSync(endpointPath, { force: true });
  return openSync(lockPath, 'wx', 0o600);
}

function releaseOwnerLock(lockPath: string, lockFd: number): void {
  const owned = fstatSync(lockFd);
  closeSync(lockFd);
  try {
    const current = statSync(lockPath);
    if (current.dev === owned.dev && current.ino === owned.ino) rmSync(lockPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
}

function writeFinalFrame(socket: Socket, frame: string): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, RUN_LIVE_OWNER_IPC_TIMEOUT_MS);
    socket.end(frame, finish);
    socket.once('error', finish);
    socket.once('close', finish);
  });
}

function stopResponseFrame(response: StopResponse): string {
  return `${JSON.stringify(response)}\n`;
}

/** Publish the exact process entry that currently owns execution of one run. */
export async function startRunLiveOwner(
  runId: string,
  options: RunLiveOwnerOptions = {}
): Promise<RunLiveOwner> {
  if (
    options.detachedProcessPid !== undefined &&
    (!Number.isInteger(options.detachedProcessPid) || options.detachedProcessPid <= 0)
  ) {
    throw new Error(`Invalid detached run-owner PID ${String(options.detachedProcessPid)}`);
  }
  const path = runLiveOwnerPath(runId);
  const lockPath = runLiveOwnerLockPath(runId);
  const lockFd = await acquireOwnerLock(runId, path);
  const sockets = new Set<Socket>();
  const watcherSockets = new Set<Socket>();
  const stopSockets = new Set<Socket>();
  const stopReleaseWaiters = new Set<() => void>();

  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(RUN_LIVE_OWNER_IPC_TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());

    let request = '';
    let phase: 'request' | 'watching' | 'lease' | 'terminating' = 'request';
    socket.on('data', chunk => {
      request += chunk;
      if (Buffer.byteLength(request) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      let newline = request.indexOf('\n');
      while (newline !== -1) {
        const frame = request.slice(0, newline + 1);
        request = request.slice(newline + 1);
        if (phase === 'request' && frame === WATCH_REQUEST) {
          phase = 'watching';
          watcherSockets.add(socket);
          socket.setTimeout(0);
          socket.write(WATCH_READY);
        } else if (phase === 'request' && frame === STOP_REQUEST) {
          if (options.detachedProcessPid === undefined) {
            socket.end(stopResponseFrame({ kind: 'unsupported' }));
            return;
          }
          phase = 'lease';
          stopSockets.add(socket);
          socket.setTimeout(RUN_LIVE_OWNER_IPC_TIMEOUT_MS, () => socket.destroy());
          socket.write(stopResponseFrame({ kind: 'detached', pid: options.detachedProcessPid }));
        } else if (phase === 'lease' && frame === TERMINATE_REQUEST) {
          phase = 'terminating';
          socket.setTimeout(TERMINATION_LEASE_MS, () => socket.destroy());
          for (const watcher of watcherSockets) watcher.write(CONTROL_HANDOFF);
          socket.write(TERMINATE_READY);
        } else {
          socket.destroy();
          return;
        }
        newline = request.indexOf('\n');
      }
    });
    socket.once('close', () => {
      sockets.delete(socket);
      watcherSockets.delete(socket);
      if (stopSockets.delete(socket) && stopSockets.size === 0) {
        for (const resolve of stopReleaseWaiters) resolve();
        stopReleaseWaiters.clear();
      }
    });
  });
  // Errors after a successful listen make the owner unreachable. The waiter then
  // reports that fact from the endpoint plus the durable row.
  server.on('error', () => undefined);

  try {
    await listenWithoutReplacingOwner(server, path);
  } catch (error) {
    releaseOwnerLock(lockPath, lockFd);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    close: async (): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = (async (): Promise<void> => {
        if (stopSockets.size > 0) {
          await new Promise<void>(resolve => {
            const finish = (): void => {
              clearTimeout(timer);
              stopReleaseWaiters.delete(finish);
              resolve();
            };
            stopReleaseWaiters.add(finish);
            const timer = setTimeout(() => {
              for (const socket of stopSockets) socket.destroy();
              finish();
            }, OWNER_CLOSE_WAIT_MS);
          });
        }
        await Promise.all(
          [...watcherSockets].map(socket => writeFinalFrame(socket, OWNER_ATTENTION))
        );
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          await new Promise<void>(resolve =>
            server.close(() => {
              resolve();
            })
          );
        }
        if (process.platform !== 'win32') rmSync(path, { force: true });
        releaseOwnerLock(lockPath, lockFd);
      })();
      return closePromise;
    },
    isStopRequested: (): boolean => stopSockets.size > 0,
  };
}

/** Acquire an owner for exactly the lifetime of one execution claim. */
export async function withRunLiveOwner<T>(
  runId: string,
  options: RunLiveOwnerOptions,
  body: (owner: RunLiveOwner) => Promise<T>
): Promise<T> {
  const owner = await startRunLiveOwner(runId, options);
  try {
    return await body(owner);
  } finally {
    await owner.close();
  }
}

/**
 * Attach to a live owner. `null` means the exact endpoint could not complete the
 * watch handshake. Once this resolves with a handle, disconnects are observable.
 */
export function watchRunLiveOwner(
  runId: string,
  onEvent: (event: RunLiveOwnerWatchEvent) => void
): Promise<RunLiveOwnerWatch | null> {
  const path = runLiveOwnerPath(runId);
  return new Promise(resolve => {
    const socket = new Socket();
    let response = '';
    let attached = false;
    let settled = false;
    let unsubscribed = false;
    let terminalFrame = false;
    let disconnectReported = false;

    const unavailable = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(null);
    };
    const disconnected = (): void => {
      if (attached && !unsubscribed && !terminalFrame && !disconnectReported) {
        disconnectReported = true;
        onEvent('disconnected');
      } else unavailable();
    };

    socket.setEncoding('utf8');
    socket.setTimeout(RUN_LIVE_OWNER_IPC_TIMEOUT_MS, unavailable);
    socket.once('error', disconnected);
    socket.once('end', disconnected);
    socket.once('close', disconnected);
    socket.once('connect', () => socket.write(WATCH_REQUEST));
    socket.on('data', chunk => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) {
        unavailable();
        return;
      }
      let newline = response.indexOf('\n');
      while (newline !== -1) {
        const frame = response.slice(0, newline + 1);
        response = response.slice(newline + 1);
        if (!attached) {
          if (frame !== WATCH_READY) {
            unavailable();
            return;
          }
          attached = true;
          settled = true;
          socket.setTimeout(0);
          resolve({
            unsubscribe: (): void => {
              if (unsubscribed) return;
              unsubscribed = true;
              socket.destroy();
            },
          });
        } else if (frame === OWNER_ATTENTION) {
          terminalFrame = true;
          onEvent('attention');
        } else if (frame === CONTROL_HANDOFF) {
          onEvent('control_handoff');
        } else {
          socket.destroy();
          return;
        }
        newline = response.indexOf('\n');
      }
    });
    socket.connect(path);
  });
}

function parseStopResponse(runId: string, raw: string): StopResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RunLiveOwnerStopUnavailableError(runId, 'owner returned an invalid response');
  }
  if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
    throw new RunLiveOwnerStopUnavailableError(runId, 'owner returned an invalid response');
  }
  if (parsed.kind === 'unsupported') {
    return { kind: 'unsupported' };
  }
  if (parsed.kind !== 'detached') {
    throw new RunLiveOwnerStopUnavailableError(runId, 'owner returned an invalid response');
  }
  if (
    !('pid' in parsed) ||
    typeof parsed.pid !== 'number' ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0
  ) {
    throw new RunLiveOwnerStopUnavailableError(runId, 'owner returned an invalid PID');
  }
  return { kind: 'detached', pid: parsed.pid };
}

/** Ask the exact-run owner for the detached process's termination lease. */
export function requestRunLiveOwnerStop(runId: string): Promise<RunLiveOwnerStopLease> {
  const path = runLiveOwnerPath(runId);
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let response = '';
    let settled = false;
    const fail = (detail: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new RunLiveOwnerStopUnavailableError(runId, detail));
    };
    const onEnd = (): void => {
      fail('owner ended before identifying itself');
    };
    const onClose = (): void => {
      fail('owner closed before identifying itself');
    };

    socket.setEncoding('utf8');
    socket.setTimeout(RUN_LIVE_OWNER_IPC_TIMEOUT_MS, () => {
      fail('owner did not respond');
    });
    socket.once('error', error => {
      fail((error as NodeJS.ErrnoException).code ?? error.message);
    });
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('connect', () => socket.write(STOP_REQUEST));
    socket.on('data', chunk => {
      if (settled) return;
      response += chunk;
      if (Buffer.byteLength(response) > MAX_MESSAGE_BYTES) {
        fail('owner response exceeded its size limit');
        return;
      }
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      try {
        const stopResponse = parseStopResponse(runId, response.slice(0, newline));
        if (stopResponse.kind === 'unsupported') {
          throw new RunLiveOwnerStopUnavailableError(runId, 'the live owner is not a detached CLI');
        }
        settled = true;
        socket.off('end', onEnd);
        socket.off('close', onClose);
        socket.setTimeout(0);
        let released = false;
        let committed = false;
        const release = (): void => {
          if (released) return;
          released = true;
          socket.destroy();
        };
        resolve({
          pid: stopResponse.pid,
          commit: async (): Promise<void> => {
            if (committed) throw new Error('Run termination lease is already committed');
            if (released || socket.destroyed || socket.readableEnded) {
              throw new Error('Run owner ended before termination started');
            }
            committed = true;
            await new Promise<void>((ready, rejectReady) => {
              let acknowledgement = '';
              const cleanup = (): void => {
                socket.off('data', onData);
                socket.off('error', onError);
                socket.off('end', onLeaseEnd);
                socket.off('close', onLeaseClose);
                socket.off('timeout', onTimeout);
              };
              const failReady = (error: Error): void => {
                cleanup();
                rejectReady(error);
              };
              const onData = (data: string): void => {
                acknowledgement += data;
                if (Buffer.byteLength(acknowledgement) > MAX_MESSAGE_BYTES) {
                  failReady(new Error('Run owner acknowledgement exceeded its size limit'));
                  return;
                }
                const readyNewline = acknowledgement.indexOf('\n');
                if (readyNewline === -1) return;
                if (acknowledgement.slice(0, readyNewline + 1) !== TERMINATE_READY) {
                  failReady(new Error('Run owner returned an invalid acknowledgement'));
                  return;
                }
                cleanup();
                socket.setTimeout(TERMINATION_LEASE_MS, () => socket.destroy());
                ready();
              };
              const onError = (error: Error): void => {
                failReady(error);
              };
              const onLeaseEnd = (): void => {
                failReady(new Error('Run owner ended before committing termination'));
              };
              const onLeaseClose = (): void => {
                failReady(new Error('Run owner closed before committing termination'));
              };
              const onTimeout = (): void => {
                failReady(new Error('Run owner did not commit the termination lease'));
              };
              socket.on('data', onData);
              socket.once('error', onError);
              socket.once('end', onLeaseEnd);
              socket.once('close', onLeaseClose);
              socket.once('timeout', onTimeout);
              socket.setTimeout(RUN_LIVE_OWNER_IPC_TIMEOUT_MS);
              socket.write(TERMINATE_REQUEST, error => {
                if (error) failReady(error);
              });
            });
          },
          release,
          isLive: (): boolean => !released && !socket.destroyed,
        });
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.connect(path);
  });
}
