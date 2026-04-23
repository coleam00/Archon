import { spawn } from 'node:child_process';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode.server');
  return cachedLog;
}

export interface ServerConfig {
  port: number;
  hostname: string;
  cwd: string;
  password: string;
}

export interface ServerInfo {
  hostname: string;
  port: number;
  password: string;
  pid?: number;
}

/** Shared server process reference — one server per Archon process. */
let managedServer: { proc: ReturnType<typeof spawn>; info: ServerInfo } | undefined;

/**
 * Ensure OpenCode Server is running. If `autoStartServer` is true and no
 * server is listening, spawn `opencode serve` and wait for readiness.
 *
 * Idempotent per Archon process: once a server is started, subsequent calls
 * return the same info without spawning a new process.
 */
export async function ensureServer(config: ServerConfig, autoStart = true): Promise<ServerInfo> {
  // 1. Check if a previously managed server is still healthy
  if (managedServer) {
    const isRunning = await checkHealth(managedServer.info.hostname, managedServer.info.port);
    if (isRunning) {
      getLog().debug({ port: managedServer.info.port }, 'opencode.server.already_running');
      return managedServer.info;
    }
    // Server died — clear the reference so we can respawn
    managedServer = undefined;
  }

  // 2. Check if an external server is already listening
  const isRunning = await checkHealth(config.hostname, config.port);
  if (isRunning) {
    getLog().debug({ port: config.port }, 'opencode.server.external_detected');
    return { hostname: config.hostname, port: config.port, password: config.password };
  }

  if (!autoStart) {
    throw new Error(
      `OpenCode Server is not running at ${config.hostname}:${config.port} and autoStartServer is disabled. ` +
        `Start it manually with: opencode serve --port ${config.port} --hostname ${config.hostname}`
    );
  }

  // 3. Start the server
  getLog().info({ port: config.port, cwd: config.cwd }, 'opencode.server.starting');

  const proc = spawn(
    'opencode',
    ['serve', '--port', String(config.port), '--hostname', config.hostname],
    {
      cwd: config.cwd,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: config.password,
      },
      detached: false,
      stdio: 'pipe',
    }
  );

  proc.on('error', err => {
    getLog().error({ err }, 'opencode.server.process_error');
  });

  proc.stderr?.on('data', (data: Buffer) => {
    getLog().debug({ msg: data.toString().trim() }, 'opencode.server.stderr');
  });

  // 4. Wait for readiness
  await waitForReady(config.hostname, config.port, 30000);

  const info: ServerInfo = {
    hostname: config.hostname,
    port: config.port,
    password: config.password,
    pid: proc.pid ?? undefined,
  };

  managedServer = { proc, info };

  getLog().info({ pid: proc.pid, port: config.port }, 'opencode.server.ready');

  return info;
}

async function checkHealth(hostname: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${hostname}:${port}/global/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForReady(hostname: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(hostname, port)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`OpenCode Server failed to start on ${hostname}:${port} within ${timeoutMs}ms`);
}

/**
 * Generate a random password for the OpenCode Server.
 */
export function generatePassword(): string {
  return `archon-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
