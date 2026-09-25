import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const FORGE_PLUGIN_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const FORGE_PLUGIN_TIMEOUT_MS = 30_000;

export interface PluginArgv {
  command: string;
  args: readonly string[];
}

export interface PluginProcessResult {
  /** Whether the child process reached the operating system, so a mutation may
   * have been submitted even when this call learned nothing else about it. */
  launched: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
  spawnError?: string;
  terminationError?: string;
}

const SAFE_ENV = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
]);

export function pluginProcessEnv(env: NodeJS.ProcessEnv, token?: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SAFE_ENV.has(key.toUpperCase()) && value !== undefined) clean[key] = value;
  }
  if (token !== undefined) clean.ARCHON_FORGE_TOKEN = token;
  return clean;
}

export function redactToken(text: string, token?: string): string {
  if (!token) return text;
  const encoded = JSON.stringify(token).slice(1, -1);
  return text.split(token).join('[REDACTED]').split(encoded).join('[REDACTED]');
}

function validateCommand(command: string): string | undefined {
  if (!isAbsolute(command)) return 'plugin command must be an absolute executable path';
  const extension = extname(command).toLowerCase();
  if (extension === '.cmd' || extension === '.bat')
    return 'plugin command cannot be a .cmd or .bat file';
  if (process.platform === 'win32' && extension !== '.exe')
    return 'Windows plugin command must be an .exe file';
  return undefined;
}

async function terminateTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    await execFileAsync(
      join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        windowsHide: true,
        timeout: 5_000,
      }
    );
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function runPluginProcess(
  argv: PluginArgv,
  operationArgs: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdin?: string;
    token?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  }
): Promise<PluginProcessResult> {
  const invalid = validateCommand(argv.command);
  if (invalid)
    return {
      launched: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      outputExceeded: false,
      spawnError: invalid,
    };
  if (options.signal?.aborted)
    return {
      launched: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      outputExceeded: false,
    };

  return new Promise(resolve => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let spawnError: string | undefined;
    let terminationError: string | undefined;
    let terminating: Promise<void> | undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(argv.command, [...argv.args, ...operationArgs], {
        detached: process.platform !== 'win32',
        env: pluginProcessEnv(options.env, options.token),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: (options.timeoutMs ?? FORGE_PLUGIN_TIMEOUT_MS) + 5_000,
        killSignal: 'SIGKILL',
      });
    } catch (error) {
      resolve({
        launched: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        outputExceeded: false,
        spawnError: redactToken(
          error instanceof Error ? error.message : 'forge plugin process could not be launched',
          options.token
        ),
      });
      return;
    }
    let launched = child.pid !== undefined;
    child.once('spawn', () => {
      launched = true;
    });
    const terminate = (): void => {
      if (terminating || child.pid === undefined) return;
      terminating = terminateTree(child.pid)
        .catch(() => {
          terminationError = 'failed to terminate plugin process tree';
          child.kill('SIGKILL');
        })
        .finally(() => {
          // A surviving descendant can keep inherited pipes open after the
          // parent exits. Teardown must still release the bounded operation.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? FORGE_PLUGIN_TIMEOUT_MS);
    const abort = (): void => {
      timedOut = true;
      terminate();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (outputExceeded) return;
      bytes += chunk.byteLength;
      if (bytes > (options.maxOutputBytes ?? FORGE_PLUGIN_MAX_OUTPUT_BYTES)) {
        outputExceeded = true;
        terminate();
      } else target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.on('error', error => {
      spawnError = error.message;
    });
    child.stdin.on('error', error => {
      if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes((error as NodeJS.ErrnoException).code ?? ''))
        spawnError = error.message;
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void (async (): Promise<void> => {
        await terminating;
        resolve({
          launched,
          exitCode,
          stdout: redactToken(Buffer.concat(stdout).toString('utf8'), options.token),
          stderr: redactToken(Buffer.concat(stderr).toString('utf8'), options.token),
          timedOut,
          outputExceeded,
          ...(spawnError ? { spawnError: redactToken(spawnError, options.token) } : {}),
          ...(terminationError ? { terminationError } : {}),
        });
      })();
    });
    child.stdin.end(options.stdin ?? '');
  });
}
