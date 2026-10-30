import { execFile } from 'node:child_process';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from './logger';
import { probePidLiveness } from './process-owner';
import {
  readWindowsProcessIdentity,
  type WindowsProcessIdentity,
} from './windows-process-identity';

const execFileAsync = promisify(execFile);

export type ProcessGroupStop =
  | { pgid: number; leaderReaped: true }
  | { pgid: number; leaderReaped: false; signalError?: string };

async function listPosixProcessGroups(): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pgid='], { timeout: 5000 });
  return stdout;
}

/** Inspect recorded groups without a signal, including signal 0 after leader reaping. */
export async function inspectProcessGroups(
  pgids: readonly number[],
  listGroups: () => Promise<string> = listPosixProcessGroups
): Promise<number[]> {
  if (pgids.length === 0) return [];
  const groups = new Set(pgids);
  const members: number[] = [];
  for (const line of (await listGroups()).split('\n')) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s*$/.exec(line);
    if (!fields) throw new Error('Invalid POSIX process listing');
    const pgid = Number(fields[1]);
    if (!Number.isSafeInteger(pgid) || pgid < 0) {
      throw new Error('Invalid POSIX process identifier');
    }
    if (groups.has(pgid)) members.push(pgid);
  }
  return members;
}

export async function confirmProcessGroupsGone(
  pgids: readonly number[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const members = await inspectProcessGroups(pgids);
    if (members.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Process groups still running: ${[...new Set(members)].join(', ')}`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

export function validateCommand(command: string): string | undefined {
  if (!isAbsolute(command)) return 'plugin command must be an absolute executable path';
  const extension = extname(command).toLowerCase();
  if (extension === '.cmd' || extension === '.bat')
    return 'plugin command cannot be a .cmd or .bat file';
  if (process.platform === 'win32' && extension !== '.exe')
    return 'Windows plugin command must be an .exe file';
  return undefined;
}

async function listPosixProcessGroupStates(): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pgid=,stat='], { timeout: 5000 });
  return stdout;
}

function processGroupHasEnded(pgid: number, listing: string): boolean {
  for (const line of listing.split('\n')) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!fields) throw new Error('Invalid POSIX process listing');
    const group = Number(fields[1]);
    if (!Number.isSafeInteger(group)) throw new Error('Invalid POSIX process identifier');
    if (group === pgid && !fields[2].startsWith('Z')) return false;
  }
  return true;
}

/** End the process group led by `pid` on POSIX, or the tree rooted at `pid` on Windows. */
export async function terminateTree(
  pid: number,
  posixSignal: NodeJS.Signals = 'SIGKILL',
  listGroups: () => Promise<string> = listPosixProcessGroupStates
): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid);
    return;
  }
  try {
    process.kill(-pid, posixSignal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    if (code === 'EPERM') {
      // Darwin can refuse signals to zombie-only groups. Failed observation proves nothing.
      try {
        if (processGroupHasEnded(pid, await listGroups())) return;
      } catch {
        // Preserve the original signal error when the process table cannot prove exit.
      }
    }
    throw error;
  }
}

export async function terminateWindowsTree(
  pid: number,
  taskkill: (pid: number) => Promise<unknown> = runTaskkill
): Promise<void> {
  const log = createLogger('paths.plugin-process');
  const debug = log.isLevelEnabled('debug');
  const identity = async (): Promise<WindowsProcessIdentity> => {
    try {
      return await readWindowsProcessIdentity(pid);
    } catch {
      return { pid, status: 'unavailable', code: 'CAPTURE_FAILED' };
    }
  };
  const entryIdentity = debug ? await identity() : undefined;
  try {
    await taskkill(pid);
  } catch (error) {
    const liveness = probePidLiveness(pid);
    const gone = liveness.status === 'threw' && liveness.code === 'ESRCH';
    const level = gone ? 'debug' : 'warn';
    if (log.isLevelEnabled(level)) {
      const failureIdentity = await identity();
      try {
        log[level](
          {
            targetPid: pid,
            phase: 'taskkill_failed',
            entryIdentity,
            failureIdentity,
            liveness,
            taskkill: taskkillFailureFields(error),
          },
          'process.windows_tree_stop'
        );
      } catch {
        // Optional diagnostics must not replace the saved stop result.
      }
    }
    // Identity samples and taskkill's prose are diagnostic evidence, never stop authorization.
    if (!gone) throw error;
  }
}

function taskkillFailureFields(error: unknown): {
  code: string | number | null;
  stderr: string | null;
} {
  if (typeof error !== 'object' || error === null) return { code: null, stderr: null };
  const code =
    'code' in error && (typeof error.code === 'number' || typeof error.code === 'string')
      ? error.code
      : null;
  const stderr =
    'stderr' in error && (typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr))
      ? error.stderr.toString()
      : null;
  return { code, stderr };
}

function runTaskkill(pid: number): Promise<unknown> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return execFileAsync(
    join(systemRoot, 'System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, timeout: 5_000 }
  );
}
