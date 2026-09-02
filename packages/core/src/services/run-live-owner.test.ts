import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server, Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  canConnectToRunLiveOwner,
  requestRunLiveOwnerStop,
  runLiveOwnerPath,
  RunLiveOwnerStopUnavailableError,
  startRunLiveOwner,
  watchRunLiveOwner,
  withRunLiveOwner,
  type RunLiveOwnerWatchEvent,
} from './run-live-owner';

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for live-owner event');
    await Bun.sleep(5);
  }
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('run live owner', () => {
  test('publishes one exact-run endpoint and treats a connection as a harmless probe', async () => {
    const runId = `owner-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    const owner = await startRunLiveOwner(runId);
    try {
      expect(await canConnectToRunLiveOwner(path)).toBe(true);
      expect(owner.isStopRequested()).toBe(false);
      await expect(startRunLiveOwner(runId)).rejects.toThrow(/already owned/);
      if (process.platform !== 'win32') {
        expect(statSync(dirname(path)).mode & 0o077).toBe(0);
        expect(path).not.toContain(runId);
      }
    } finally {
      await owner.close();
    }
    expect(await canConnectToRunLiveOwner(path)).toBe(false);
    if (process.platform !== 'win32') {
      expect(existsSync(path)).toBe(false);
      expect(existsSync(path.replace(/\.sock$/, '.lock'))).toBe(false);
    }
  });

  test('keeps concurrent run owners independent', async () => {
    const firstId = `concurrent-first-${crypto.randomUUID()}`;
    const secondId = `concurrent-second-${crypto.randomUUID()}`;
    const firstPath = runLiveOwnerPath(firstId);
    const secondPath = runLiveOwnerPath(secondId);
    const first = await startRunLiveOwner(firstId);
    const second = await startRunLiveOwner(secondId);
    try {
      expect(await canConnectToRunLiveOwner(firstPath)).toBe(true);
      expect(await canConnectToRunLiveOwner(secondPath)).toBe(true);
      await first.close();
      expect(await canConnectToRunLiveOwner(firstPath)).toBe(false);
      expect(await canConnectToRunLiveOwner(secondPath)).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('rings every watcher before normal close without also reporting disconnect', async () => {
    const runId = `watchers-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(runId);
    const first: RunLiveOwnerWatchEvent[] = [];
    const second: RunLiveOwnerWatchEvent[] = [];
    const firstWatch = await watchRunLiveOwner(runId, event => first.push(event));
    const secondWatch = await watchRunLiveOwner(runId, event => second.push(event));
    expect(firstWatch).not.toBeNull();
    expect(secondWatch).not.toBeNull();

    await owner.close();
    await waitFor(() => first.length === 1 && second.length === 1);

    expect(first).toEqual(['attention']);
    expect(second).toEqual(['attention']);
  });

  test('closes and rings the owner when its wrapped execution rejects', async () => {
    const runId = `rejected-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    const events: RunLiveOwnerWatchEvent[] = [];
    const executionError = new Error('execution failed');
    let rejection: unknown;

    try {
      await withRunLiveOwner(runId, {}, async () => {
        const watch = await watchRunLiveOwner(runId, event => events.push(event));
        expect(watch).not.toBeNull();
        throw executionError;
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBe(executionError);
    await waitFor(() => events.length === 1);
    expect(events).toEqual(['attention']);
    expect(await canConnectToRunLiveOwner(path)).toBe(false);
  });

  test('foreground and server owners refuse active stop without changing owner state', async () => {
    const runId = `foreground-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(runId);
    try {
      await expect(requestRunLiveOwnerStop(runId)).rejects.toBeInstanceOf(
        RunLiveOwnerStopUnavailableError
      );
      expect(owner.isStopRequested()).toBe(false);
    } finally {
      await owner.close();
    }
  });

  test('detached stop commit announces the controller handoff before close', async () => {
    const runId = `detached-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(runId, { detachedProcessPid: process.pid });
    const events: RunLiveOwnerWatchEvent[] = [];
    const watch = await watchRunLiveOwner(runId, event => events.push(event));
    expect(watch).not.toBeNull();
    const lease = await requestRunLiveOwnerStop(runId);
    try {
      expect(lease.pid).toBe(process.pid);
      expect(owner.isStopRequested()).toBe(true);
      await lease.commit();
      await waitFor(() => events.includes('control_handoff'));
      expect(events).toEqual(['control_handoff']);
    } finally {
      lease.release();
      await owner.close();
    }
    await waitFor(() => events.includes('attention'));
    expect(events).toEqual(['control_handoff', 'attention']);
  });

  test('bounds close while a controller retains an uncommitted stop lease', async () => {
    const runId = `retained-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    const owner = await startRunLiveOwner(runId, { detachedProcessPid: process.pid });
    const client = new Socket();
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
      client.connect(path);
    });
    client.write('stop\n');
    await waitFor(() => owner.isStopRequested());

    const closing = owner.close();
    expect(await canConnectToRunLiveOwner(path)).toBe(true);
    expect(owner.isStopRequested()).toBe(true);

    await closing;
    expect(owner.isStopRequested()).toBe(false);
    expect(await canConnectToRunLiveOwner(path)).toBe(false);
    client.destroy();
  });

  test('refuses a stop when the owner closes before identifying itself', async () => {
    const runId = `close-before-pid-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    const server = createServer(socket => {
      socket.once('data', () => socket.end());
    });
    await listen(server, path);
    try {
      await expect(requestRunLiveOwnerStop(runId)).rejects.toThrow(
        /owner (?:ended|closed) before identifying itself/
      );
    } finally {
      await close(server);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });

  test('refuses a committed stop when the owner disconnects before acknowledging it', async () => {
    const runId = `close-before-ready-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    const server = createServer(socket => {
      socket.setEncoding('utf8');
      let request = '';
      socket.on('data', chunk => {
        request += chunk;
        if (request.includes('stop\n')) {
          socket.write(`${JSON.stringify({ kind: 'detached', pid: 12345 })}\n`);
          request = request.replace('stop\n', '');
        }
        if (request.includes('terminate\n')) socket.destroy();
      });
    });
    await listen(server, path);
    try {
      const lease = await requestRunLiveOwnerStop(runId);
      try {
        // Bun reports a destroyed Windows named pipe through the bounded idle timeout;
        // POSIX sockets report their peer's EOF immediately.
        const expectedFailure =
          process.platform === 'win32'
            ? /owner did not commit the termination lease/
            : /owner (?:ended|closed) before committing termination/;
        await expect(lease.commit()).rejects.toThrow(expectedFailure);
      } finally {
        lease.release();
      }
    } finally {
      await close(server);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });

  test('reports an unexpected post-handshake disconnect', async () => {
    const runId = `abrupt-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    const server = createServer(socket => {
      socket.once('data', () => {
        socket.write('watching\n');
        socket.destroy();
      });
    });
    await listen(server, path);
    const events: RunLiveOwnerWatchEvent[] = [];
    try {
      const watch = await watchRunLiveOwner(runId, event => events.push(event));
      expect(watch).not.toBeNull();
      await waitFor(() => events.length > 0);
      expect(events).toEqual(['disconnected']);
    } finally {
      await close(server);
    }
  });

  test('recovers a stale POSIX endpoint only after connection refusal', async () => {
    if (process.platform === 'win32') return;
    const runId = `stale-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    writeFileSync(path, 'stale');
    chmodSync(path, 0o600);

    const owner = await startRunLiveOwner(runId);
    try {
      expect(await canConnectToRunLiveOwner(path)).toBe(true);
    } finally {
      await owner.close();
    }
  });
});
