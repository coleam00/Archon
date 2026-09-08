import { spawn, execFile } from 'node:child_process';
import { isAbsolute, extname, join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const FORGE_DISPATCH_MAX_BUFFER = 16 * 1024 * 1024;
export const FORGE_DISPATCH_DEFAULT_TIMEOUT_MS = 30_000;
export interface PluginCandidate {
  source: string;
  command: string;
  args: string[];
}
export interface ExecPluginOptions {
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
  signal?: AbortSignal;
}
export interface ExecPluginOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  bufferExceeded: boolean;
  spawnError?: Error;
  terminationError?: string;
}
// Windows may supply additional system variables itself. No run inputs or ambient credentials belong here.
const PROCESS_ENV_KEYS = new Set([
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
  'TZ',
]);
export function pluginEnvironment(env: NodeJS.ProcessEnv, token?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (PROCESS_ENV_KEYS.has(key.toUpperCase())) result[key] = value;
  }
  if (token) result.ARCHON_FORGE_TOKEN = token;
  return result;
}
export function redactPluginText(text: string, env: NodeJS.ProcessEnv): string {
  const token = env.ARCHON_FORGE_TOKEN;
  return token ? text.split(token).join('[REDACTED]') : text;
}
async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync(
      join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
      ),
      ['/PID', String(pid), '/T', '/F'],
      { timeout: 5_000, windowsHide: true }
    );
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
export async function execBoundedProcess(
  candidate: Pick<PluginCandidate, 'command' | 'args'>,
  opArgs: string[],
  options: ExecPluginOptions
): Promise<ExecPluginOutcome> {
  const empty: ExecPluginOutcome = {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    cancelled: false,
    bufferExceeded: false,
  };
  if (
    !isAbsolute(candidate.command) ||
    (process.platform === 'win32' && extname(candidate.command).toLowerCase() !== '.exe')
  ) {
    return {
      ...empty,
      spawnError: new Error(
        'Plugin command must be an absolute executable path; Windows requires .exe, never .cmd/.bat'
      ),
    };
  }
  if (options.signal?.aborted) return { ...empty, cancelled: true };
  return new Promise(resolve => {
    const result = { ...empty };
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let termination: Promise<void> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(candidate.command, [...candidate.args, ...opArgs], {
      env: options.env,
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const terminate = (): void => {
      if (termination || child.pid === undefined) return;
      termination = killTree(child.pid).catch(() => {
        result.terminationError = 'Process tree termination failed';
        child.kill('SIGKILL');
      });
      // Bound inherited pipes even when a descendant has escaped the process group.
      backstop = setTimeout(() => {
        result.terminationError ??= 'Process tree did not close its pipes after termination';
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, 6_000);
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, options.timeoutMs ?? FORGE_DISPATCH_DEFAULT_TIMEOUT_MS);
    const abort = (): void => {
      result.cancelled = true;
      terminate();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (result.bufferExceeded) return;
      bytes += chunk.length;
      if (bytes > (options.maxBuffer ?? FORGE_DISPATCH_MAX_BUFFER)) {
        result.bufferExceeded = true;
        terminate();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        result.spawnError = error;
        terminate();
      }
    });
    child.on('error', error => {
      result.spawnError = error;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      void (async (): Promise<void> => {
        await termination;
        if (backstop) clearTimeout(backstop);
        resolve({
          ...result,
          exitCode: code,
          signal,
          stdout: redactPluginText(Buffer.concat(stdout).toString('utf8'), options.env),
          stderr: redactPluginText(Buffer.concat(stderr).toString('utf8'), options.env),
        });
      })();
    });
    child.stdin.end(options.stdin);
  });
}

export function execPlugin(
  candidate: Pick<PluginCandidate, 'command' | 'args'>,
  opArgs: string[],
  options: ExecPluginOptions
): Promise<ExecPluginOutcome> {
  return execBoundedProcess(candidate, opArgs, {
    ...options,
    env: pluginEnvironment(options.env, options.env.ARCHON_FORGE_TOKEN),
  });
}
