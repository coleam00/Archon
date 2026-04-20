import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import {
  BUNDLED_IS_BINARY,
  createLogger,
  getAppArchonBasePath,
  getArchonHome,
} from '@archon/paths';
import { createConnection } from 'net';

const log = createLogger('cli.dev');

const DEV_STATE_DIR = join(getArchonHome(), 'run');
const DEV_STATE_PATH = join(DEV_STATE_DIR, 'dev-server.json');
const DEV_LOG_PATH = join(DEV_STATE_DIR, 'dev-server.log');

const DEFAULT_PORTS = {
  api: 3090,
  web: 3091,
  docs: 4321,
} as const;

function readPortFromEnvFile(envPath: string): number | null {
  if (!existsSync(envPath)) {
    return null;
  }

  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = /^PORT\s*=\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const value = match[1]?.trim().replace(/^['"]|['"]$/g, '');
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      return parsed;
    }
    return null;
  }

  return null;
}

function getEffectiveApiPort(repoRoot: string): number {
  const repoPort = readPortFromEnvFile(join(repoRoot, '.env'));
  const globalPort = readPortFromEnvFile(join(getArchonHome(), '.env'));
  return globalPort ?? repoPort ?? DEFAULT_PORTS.api;
}

interface DevState {
  pid: number;
  startedAt: string;
  repoRoot: string;
  logPath: string;
}

export interface DevCommandOptions {
  action: 'start' | 'stop' | 'status';
}

function getSourceRepoRoot(): string {
  return dirname(getAppArchonBasePath());
}

function ensureSourceMode(): boolean {
  if (BUNDLED_IS_BINARY) {
    console.error('Error: `archon dev` is only available from a source checkout.');
    console.error('For binary installs, use `archon serve` for the API/Web UI server.');
    return false;
  }

  return true;
}

function ensureStateDir(): void {
  mkdirSync(DEV_STATE_DIR, { recursive: true });
}

function readState(): DevState | null {
  if (!existsSync(DEV_STATE_PATH)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(DEV_STATE_PATH, 'utf8')) as DevState;
  } catch (error) {
    const err = error as Error;
    log.warn({ err, path: DEV_STATE_PATH }, 'dev.state_read_failed');
    return null;
  }
}

function writeState(state: DevState): void {
  ensureStateDir();
  writeFileSync(DEV_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clearState(): void {
  rmSync(DEV_STATE_PATH, { force: true });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderUrls(apiPort: number): void {
  console.log(`  API:  http://localhost:${String(apiPort)}`);
  console.log(`  Web:  http://localhost:${String(DEFAULT_PORTS.web)}`);
  console.log(`  Docs: http://localhost:${String(DEFAULT_PORTS.docs)}`);
}

async function isPortListening(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.setTimeout(300, () => {
      finish(false);
    });
  });
}

async function hasUnmanagedDevListeners(apiPort: number): Promise<boolean> {
  const [apiListening, webListening] = await Promise.all([
    isPortListening(apiPort),
    isPortListening(DEFAULT_PORTS.web),
  ]);

  return apiListening || webListening;
}

function removeStaleStateIfNeeded(state: DevState | null): DevState | null {
  if (state === null) {
    return null;
  }

  if (isProcessRunning(state.pid)) {
    return state;
  }

  clearState();
  return null;
}

function stopProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    process.kill(pid, signal);
    return;
  }

  process.kill(-pid, signal);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await Bun.sleep(100);
  }
  return !isProcessRunning(pid);
}

async function devStartCommand(): Promise<number> {
  const repoRoot = getSourceRepoRoot();
  const apiPort = getEffectiveApiPort(repoRoot);
  const existing = removeStaleStateIfNeeded(readState());
  if (existing !== null) {
    console.log(`Archon dev is already running (pid ${String(existing.pid)}).`);
    renderUrls(apiPort);
    console.log(`  Log:  ${existing.logPath}`);
    return 0;
  }

  if (await hasUnmanagedDevListeners(apiPort)) {
    console.error('Error: Archon dev ports are already in use by another process.');
    console.error('Stop the existing dev stack first, then run `archon dev start`.');
    return 1;
  }

  ensureStateDir();
  const outputFd = openSync(DEV_LOG_PATH, 'a');

  try {
    const child = spawn('bun', ['run', 'dev'], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', outputFd, outputFd],
    });

    if (child.pid === undefined) {
      throw new Error('Failed to start Archon dev: child process has no PID');
    }

    child.unref();

    const state: DevState = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      repoRoot,
      logPath: DEV_LOG_PATH,
    };
    writeState(state);

    console.log(`Started Archon dev in the background (pid ${String(child.pid)}).`);
    renderUrls(apiPort);
    console.log(`  Log:  ${DEV_LOG_PATH}`);
    console.log('Stop it later with: archon dev stop');
    return 0;
  } finally {
    closeSync(outputFd);
  }
}

async function devStopCommand(): Promise<number> {
  const apiPort = getEffectiveApiPort(getSourceRepoRoot());
  const state = removeStaleStateIfNeeded(readState());
  if (state === null) {
    if (await hasUnmanagedDevListeners(apiPort)) {
      console.log('Archon dev appears to be running, but it is not managed by `archon dev`.');
      console.log('Stop the original process manually, then restart it with `archon dev start`.');
      renderUrls(apiPort);
      return 0;
    }

    console.log('Archon dev is not running.');
    return 0;
  }

  try {
    stopProcessGroup(state.pid, 'SIGTERM');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ESRCH') {
      throw err;
    }
  }

  const stopped = await waitForExit(state.pid, 5000);
  if (!stopped) {
    stopProcessGroup(state.pid, 'SIGKILL');
    await waitForExit(state.pid, 2000);
  }

  clearState();
  console.log(`Stopped Archon dev (pid ${String(state.pid)}).`);
  return 0;
}

async function devStatusCommand(): Promise<number> {
  const apiPort = getEffectiveApiPort(getSourceRepoRoot());
  const state = removeStaleStateIfNeeded(readState());
  if (state === null) {
    if (await hasUnmanagedDevListeners(apiPort)) {
      console.log('Archon dev is running, but not managed by `archon dev`.');
      renderUrls(apiPort);
      return 0;
    }

    console.log('Archon dev is not running.');
    return 0;
  }

  console.log(`Archon dev is running (pid ${String(state.pid)}).`);
  console.log(`  Started: ${state.startedAt}`);
  console.log(`  Repo:    ${state.repoRoot}`);
  renderUrls(apiPort);
  console.log(`  Log:     ${state.logPath}`);
  return 0;
}

export async function devCommand(options: DevCommandOptions): Promise<number> {
  if (!ensureSourceMode()) {
    return 1;
  }

  switch (options.action) {
    case 'start':
      return await devStartCommand();
    case 'stop':
      return await devStopCommand();
    case 'status':
      return await devStatusCommand();
  }
}
