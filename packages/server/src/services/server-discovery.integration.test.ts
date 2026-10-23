import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  getServerRecordPath,
  readLiveServerRecord,
  readStoreId,
  type ServerRecord,
} from '@archon/paths/server-discovery';
import { trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();

interface RunningServer {
  child: ChildProcess;
  record: ServerRecord;
  exited: Promise<void>;
}

async function waitFor<T>(read: () => T | null, what: string, alive?: () => void): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    alive?.();
    const value = read();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

async function makeHome(root: string, name: string): Promise<string> {
  const home = join(root, name);
  await mkdir(home);
  await writeFile(join(home, 'config.yaml'), 'defaultAssistant: claude\n');
  return home;
}

/** Starts a real server on `home` and resolves once it is discoverable through `server.json`. */
async function startServer(home: string): Promise<RunningServer> {
  const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures/discovery-server.ts')], {
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARCHON_HOME: home,
      DATABASE_URL: '',
      ARCHON_TELEMETRY_DISABLED: '1',
      HOST: '127.0.0.1',
    },
  });
  let output = '';
  child.stdout?.on('data', chunk => (output += String(chunk)));
  child.stderr?.on('data', chunk => (output += String(chunk)));
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const record = await waitFor(
      () => {
        const found = readLiveServerRecord(home);
        return found?.pid === child.pid ? found : null;
      },
      'the server record',
      () => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
      }
    );
    return { child, record, exited };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }
}

async function stop(server: RunningServer, signal: NodeJS.Signals): Promise<void> {
  server.child.kill(signal);
  await server.exited;
}

async function health(record: ServerRecord): Promise<{ text: string; storeId?: string }> {
  const response = await fetch(`http://127.0.0.1:${String(record.port)}/api/health`);
  expect(response.status).toBe(200);
  const text = await response.text();
  return { text, storeId: (JSON.parse(text) as { storeId?: string }).storeId };
}

test('each home answers with its own store id, kept across a restart', async () => {
  const root = trackTempRoot(await realpath(mkdtempSync(join(tmpdir(), 'archon-discovery-'))));
  const homes = [await makeHome(root, 'home-a'), await makeHome(root, 'home-b')];
  const servers: RunningServer[] = [];
  try {
    for (const home of homes) servers.push(await startServer(home));
    const [first, second] = await Promise.all(servers.map(server => health(server.record)));
    expect(first.storeId).toBe(readStoreId(homes[0]) ?? 'missing');
    expect(second.storeId).toBe(readStoreId(homes[1]) ?? 'missing');
    expect(first.storeId).not.toBe(second.storeId);
    expect(servers[0].record).toMatchObject({ host: '127.0.0.1', storeId: first.storeId });

    // Health is unauthenticated, so it must not let a caller confirm any local path.
    for (const [index, home] of homes.entries()) {
      const { text } = index === 0 ? first : second;
      for (const fragment of [home, root, basename(home), basename(root), homedir(), tmpdir()])
        expect(text).not.toContain(fragment);
    }

    // A hard kill leaves the record behind, naming a process that no longer exists.
    await stop(servers[0], 'SIGKILL');
    expect(existsSync(getServerRecordPath(homes[0]))).toBe(true);
    expect(readLiveServerRecord(homes[0])).toBeNull();

    servers[0] = await startServer(homes[0]);
    expect((await health(servers[0].record)).storeId).toBe(first.storeId);
  } finally {
    for (const server of servers) await stop(server, 'SIGKILL');
  }
}, 90_000);

// Windows has no SIGTERM handler to run, so a kill there is always a hard kill.
test.skipIf(process.platform === 'win32')(
  'a clean shutdown removes the server record',
  async () => {
    const root = trackTempRoot(await realpath(mkdtempSync(join(tmpdir(), 'archon-discovery-'))));
    const home = await makeHome(root, 'home');
    const server = await startServer(home);
    try {
      await stop(server, 'SIGTERM');
      expect(server.child.exitCode).toBe(0);
      expect(existsSync(getServerRecordPath(home))).toBe(false);
    } finally {
      await stop(server, 'SIGKILL');
    }
  },
  60_000
);
