import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const tmpHome = '/tmp/archon-cli-dev-test-home';
const tmpRepo = '/tmp/archon-cli-dev-test-repo';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => tmpHome),
  getAppArchonBasePath: mock(() => join(tmpRepo, '.archon')),
  BUNDLED_IS_BINARY: false,
}));

const mockSpawn = mock(() => ({
  pid: 4242,
  unref: mock(() => undefined),
}));

mock.module('child_process', () => ({
  spawn: mockSpawn,
}));

mock.module('net', () => ({
  createConnection: mock(() => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      setTimeout: (_timeout: number, _cb: () => void) => void;
    };
    socket.destroy = () => undefined;
    socket.setTimeout = (_timeout: number, _cb: () => void) => undefined;
    queueMicrotask(() => {
      socket.emit('error', new Error('ECONNREFUSED'));
    });
    return socket;
  }),
}));

const { devCommand } = await import('./dev');

describe('devCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let processKillSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpRepo, { recursive: true, force: true });
    mkdirSync(tmpHome, { recursive: true });
    mkdirSync(join(tmpRepo, '.archon'), { recursive: true });
    mkdirSync(join(tmpHome), { recursive: true });
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    processKillSpy = spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === 4242 || pid === -4242) {
        return true;
      }
      throw new Error(`unexpected pid ${String(pid)}`);
    }) as typeof process.kill);
    mockSpawn.mockClear();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processKillSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('starts dev in the background and writes state', async () => {
    const exitCode = await devCommand({ action: 'start' });

    expect(exitCode).toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnCall = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(spawnCall).toEqual([
      'bun',
      ['run', 'dev'],
      expect.objectContaining({
        cwd: tmpRepo,
        detached: true,
      }),
    ]);

    const statePath = join(tmpHome, 'run', 'dev-server.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      pid: number;
      repoRoot: string;
      logPath: string;
    };

    expect(state.pid).toBe(4242);
    expect(state.repoRoot).toBe(tmpRepo);
    expect(state.logPath).toBe(join(tmpHome, 'run', 'dev-server.log'));
  });

  it('reports already running when state points to a live process', async () => {
    await devCommand({ action: 'start' });
    mockSpawn.mockClear();

    const exitCode = await devCommand({ action: 'start' });

    expect(exitCode).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith('Archon dev is already running (pid 4242).');
  });

  it('stops a running dev process and clears state', async () => {
    await devCommand({ action: 'start' });
    let running = true;
    processKillSpy.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === -4242 && signal === 'SIGTERM') {
        running = false;
        return true;
      }
      if (pid === 4242 && signal === 0) {
        if (running) {
          return true;
        }
        throw Object.assign(new Error('not running'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);

    const exitCode = await devCommand({ action: 'stop' });

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith('Stopped Archon dev (pid 4242).');
  });

  it('reports stopped state when no process is running', async () => {
    const exitCode = await devCommand({ action: 'status' });

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith('Archon dev is not running.');
  });

  it('renders api url from repo env port', async () => {
    writeFileSync(join(tmpRepo, '.env'), 'PORT=4123\n', 'utf8');

    const exitCode = await devCommand({ action: 'start' });

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith('  API:  http://localhost:4123');
  });

  it('prefers global archon env port over repo env port', async () => {
    writeFileSync(join(tmpRepo, '.env'), 'PORT=4123\n', 'utf8');
    writeFileSync(join(tmpHome, '.env'), 'PORT=4987\n', 'utf8');

    const exitCode = await devCommand({ action: 'start' });

    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith('  API:  http://localhost:4987');
  });
});
