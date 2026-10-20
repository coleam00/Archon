import { createLogger } from '@archon/paths';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const OPENCODE_START_TIMEOUT_MS = 5000;
const OPENCODE_START_MAX_RETRIES = 3;

function generateRandomPassword(): string {
  return randomBytes(32).toString('hex');
}

// Deliberately no `permission` key here: the embedded server must inherit
// whatever `ask`/`allow`/`deny` policy the user's own OpenCode config (global
// or project) resolves to. An embedded server is not an execution sandbox,
// and a node's `tools`/`disallowedTools` map (agent-config.ts) is an
// orthogonal enable/disable gate, not a substitute for the user's directory
// or repeated-action approval policy. A workflow node running unattended
// against an unresolved `ask` permission must fail fast instead of hanging
// (see session.ts's/multi-agent.ts's `permission.asked` handling, issue
// #3332) — it must not have its permissions silently broadened to avoid
// that hang.
//
// This is safe because `config` here becomes `OPENCODE_CONFIG_CONTENT`
// (see `createOpencodeServer` in @opencode-ai/sdk), which OpenCode *merges*
// into the resolved config rather than replacing it wholesale
// (https://opencode.ai/docs/config/#config-file — "Configuration files are
// merged together, not replaced"). Verified live: an embedded server built
// with this exact config, given no local project config, still honored this
// machine's real `~/.config/opencode/opencode.jsonc` `external_directory`
// allow-list for a path outside the session's working directory. Omitting
// `permission` here means this layer contributes nothing to that key, so
// the user's real global/project config still resolves it. Two categories,
// `doom_loop` and `external_directory`, default to `ask` upstream when
// nothing configures them at all (https://opencode.ai/docs/permissions/#defaults);
// an unattended node can legitimately hit the `permission.asked` fail-fast
// path for those two unless the user's own OpenCode config sets them to `allow`.
function buildEmbeddedServerConfig(startupPort: number): Record<string, unknown> {
  return {
    server: {
      hostname: '127.0.0.1',
      port: startupPort,
      password: generateRandomPassword(),
    },
  };
}

async function startEmbeddedOpencode(
  createOpencode: (
    options: Record<string, unknown>
  ) => Promise<{ client: unknown; server: { url: string; close(): void } }>,
  startupPort: number,
  signal?: AbortSignal,
  env: Record<string, string> = {}
): Promise<{ client: unknown; server: { url: string; close(): void } }> {
  // Server credentials belong to the embedded config, never to host or request env.
  const overlay = {
    ...env,
    OPENCODE_SERVER_PASSWORD: undefined,
    OPENCODE_SERVER_USERNAME: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overlay).map(key => [key, process.env[key]]));
  // The SDK spawns synchronously before returning its startup promise. Restore before
  // awaiting it: overlapping queries must never inherit another request's environment.
  // runtime-env.integration.spec.ts checks this contract against the installed SDK.
  try {
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return createOpencode({
      hostname: '127.0.0.1',
      port: startupPort,
      timeout: OPENCODE_START_TIMEOUT_MS,
      signal,
      config: buildEmbeddedServerConfig(startupPort),
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export interface OpencodeClientLike {
  session: {
    create(options?: Record<string, unknown>): Promise<{ data?: { id?: string } }>;
    get(options: Record<string, unknown>): Promise<{ data?: { id?: string } }>;
    promptAsync(options: Record<string, unknown>): Promise<unknown>;
    abort(options: Record<string, unknown>): Promise<unknown>;
    message(
      options: Record<string, unknown>
    ): Promise<{ data?: { info?: Record<string, unknown> } }>;
  };
  event: {
    subscribe(options?: Record<string, unknown>): Promise<{
      stream: AsyncIterable<unknown>;
    }>;
  };
  instance?: {
    dispose(options?: Record<string, unknown>): Promise<unknown>;
  };
}

export interface EmbeddedRuntime {
  client: OpencodeClientLike;
  server: { url: string; close(): void };
}

let cachedLog: ReturnType<typeof createLogger> | undefined;

function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

function extractPortFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? parseInt(parsed.port, 10) : undefined;
    return port && !isNaN(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function findProcessByPort(port: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const result = execSync(
        `powershell.exe -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const pid = parseInt(result, 10);
      return pid && !isNaN(pid) ? pid : undefined;
    } else {
      const result = execSync(`lsof -ti:${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`, {
        encoding: 'utf8',
        timeout: 5000,
        shell: '/bin/sh',
      }).trim();
      const pid = parseInt(result, 10);
      return pid && !isNaN(pid) ? pid : undefined;
    }
  } catch {
    return undefined;
  }
}

function killProcess(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (error) {
    getLog().warn({ err: error, pid }, 'opencode.process_kill_failed');
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`.toLowerCase();
  return String(error).toLowerCase();
}

function isPortBindConflict(error: unknown): boolean {
  const message = errorText(error);

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code.toUpperCase() === 'EADDRINUSE'
  ) {
    return true;
  }

  return (
    message.includes('eaddrinuse') ||
    message.includes('address already in use') ||
    message.includes('failed to start server on port')
  );
}

function pickRandomStartupPort(): number {
  // Keep away from privileged and commonly reserved ports.
  return Math.floor(Math.random() * 40000) + 20000;
}

export async function acquireEmbeddedRuntime(
  signal?: AbortSignal,
  env?: Record<string, string>
): Promise<EmbeddedRuntime> {
  if (signal?.aborted) throw new Error('OpenCode runtime startup aborted');
  const { createOpencode } = await import('@opencode-ai/sdk');
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new Error('OpenCode runtime startup aborted');
    const startupPort = pickRandomStartupPort();
    try {
      const runtime = await startEmbeddedOpencode(createOpencode, startupPort, signal, env);
      return { client: runtime.client as OpencodeClientLike, server: runtime.server };
    } catch (error) {
      if (!isPortBindConflict(error) || attempt >= OPENCODE_START_MAX_RETRIES - 1) throw error;
      getLog().warn(
        { err: error, startupPort, attempt: attempt + 1, maxAttempts: OPENCODE_START_MAX_RETRIES },
        'opencode.runtime_start_retry_after_port_conflict'
      );
    }
  }
}

export function releaseEmbeddedRuntime(runtime: EmbeddedRuntime): void {
  try {
    runtime.server.close();
  } finally {
    // Force-kill the underlying OpenCode child process.  server.close()
    // only tears down the HTTP listener; the embedded Node / opencode
    // processes remain alive on Windows and leak.
    const port = extractPortFromUrl(runtime.server.url);
    if (port) {
      const pid = findProcessByPort(port);
      if (pid) {
        getLog().debug({ port, pid }, 'opencode.killing_embedded_process');
        killProcess(pid);
      }
    }
  }
}

/**
 * Dispose OpenCode's cached instance for a directory so newly materialized
 * inline agents are discovered on the next request.
 */
export async function disposeInstanceForDirectory(
  client: OpencodeClientLike,
  directory: string
): Promise<void> {
  if (!client.instance?.dispose) return;

  try {
    await client.instance.dispose({ query: { directory } });
  } catch (error) {
    getLog().warn(
      {
        err: error,
        directory,
      },
      'opencode.instance_dispose_failed'
    );
  }
}

/** Check SDK and executable availability without starting a server or binding a port. */
export async function probeOpencodeRuntime(
  signal: AbortSignal
): Promise<'ready' | 'sdk-entrypoint-missing' | 'executable-missing'> {
  signal.throwIfAborted();
  const mod = await import('@opencode-ai/sdk');
  signal.throwIfAborted();
  if (typeof mod.createOpencode !== 'function') return 'sdk-entrypoint-missing';

  // Bun searches PATH (on Windows for .exe/.cmd/.bat/.com, not PATHEXT or cwd),
  // so a custom-PATHEXT or cwd-only install reads as missing. Without the option
  // it uses the PATH from process start, not the env the SDK spawn inherits.
  return Bun.which('opencode', { PATH: process.env.PATH }) === null
    ? 'executable-missing'
    : 'ready';
}
