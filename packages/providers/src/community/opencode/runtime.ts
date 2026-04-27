import { createLogger } from '@archon/paths';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const OPENCODE_START_TIMEOUT_MS = 5000;
const OPENCODE_START_MAX_RETRIES = 3;

function generateRandomPassword(): string {
  return randomBytes(32).toString('hex');
}

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
  signal?: AbortSignal
): Promise<{ client: unknown; server: { url: string; close(): void } }> {
  // Clear any pre-existing OpenCode server credential env vars so the embedded
  // server uses the random password generated in buildEmbeddedServerConfig rather
  // than picking up credentials intended for an external server instance.
  // Only clear them when they are actually set to avoid unnecessary mutations.
  if (process.env.OPENCODE_SERVER_PASSWORD !== undefined) {
    delete process.env.OPENCODE_SERVER_PASSWORD;
  }
  if (process.env.OPENCODE_SERVER_USERNAME !== undefined) {
    delete process.env.OPENCODE_SERVER_USERNAME;
  }

  return await createOpencode({
    hostname: '127.0.0.1',
    port: startupPort,
    timeout: OPENCODE_START_TIMEOUT_MS,
    signal,
    config: buildEmbeddedServerConfig(startupPort),
  });
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
  refCount: number;
  /** Promise that created this runtime - used to prevent race conditions on release */
  creationPromise: Promise<EmbeddedRuntime>;
}

let embeddedRuntimePromise: Promise<EmbeddedRuntime> | undefined;
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
    getLog().debug({ err: error, pid }, 'opencode.process_kill_failed');
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
    message.includes('failed to start server on port') ||
    message.includes('port 4096')
  );
}

function pickRandomStartupPort(): number {
  // Keep away from privileged and commonly reserved ports.
  return Math.floor(Math.random() * 40000) + 20000;
}

export async function acquireEmbeddedRuntime(signal?: AbortSignal): Promise<EmbeddedRuntime> {
  if (signal?.aborted) {
    throw new Error('OpenCode runtime startup aborted');
  }

  if (!embeddedRuntimePromise) {
    let resolveRuntime: ((runtime: EmbeddedRuntime) => void) | undefined;
    let rejectRuntime: ((error: unknown) => void) | undefined;

    const promise = new Promise<EmbeddedRuntime>((resolve, reject) => {
      resolveRuntime = resolve;
      rejectRuntime = reject;
    });
    embeddedRuntimePromise = promise;

    (async (): Promise<void> => {
      try {
        const { createOpencode } = await import('@opencode-ai/sdk');

        let runtime: { client: unknown; server: { url: string; close(): void } } | undefined;
        let lastError: unknown;

        for (let attempt = 0; attempt < OPENCODE_START_MAX_RETRIES; attempt += 1) {
          if (signal?.aborted) {
            throw new Error('OpenCode runtime startup aborted');
          }

          const startupPort = pickRandomStartupPort();

          try {
            runtime = await startEmbeddedOpencode(createOpencode, startupPort, signal);
            break;
          } catch (error) {
            lastError = error;
            if (!isPortBindConflict(error) || attempt >= OPENCODE_START_MAX_RETRIES - 1) {
              throw error;
            }

            getLog().warn(
              {
                err: error,
                startupPort,
                attempt: attempt + 1,
                maxAttempts: OPENCODE_START_MAX_RETRIES,
              },
              'opencode.runtime_start_retry_after_port_conflict'
            );
          }
        }

        if (!runtime) {
          throw lastError instanceof Error
            ? lastError
            : new Error('OpenCode runtime failed to start after retries');
        }

        resolveRuntime?.({
          client: runtime.client as OpencodeClientLike,
          server: runtime.server,
          refCount: 0,
          creationPromise: promise,
        });
      } catch (error) {
        embeddedRuntimePromise = undefined;
        rejectRuntime?.(error);
      }
    })();
  }

  const runtime = await embeddedRuntimePromise;
  runtime.refCount += 1;
  return runtime;
}

export function releaseEmbeddedRuntime(runtime: EmbeddedRuntime): void {
  runtime.refCount = Math.max(0, runtime.refCount - 1);
  if (runtime.refCount > 0) return;

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

    if (embeddedRuntimePromise === runtime.creationPromise) {
      embeddedRuntimePromise = undefined;
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
    getLog().debug(
      {
        err: error,
        directory,
      },
      'opencode.instance_dispose_failed'
    );
  }
}

/** Reset the embedded runtime state. For testing only. */
export function resetEmbeddedRuntime(): void {
  embeddedRuntimePromise = undefined;
}
