import { execFile } from 'node:child_process';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { isPidProvablyGone } from './process-owner';

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

/** End the process group led by `pid` on POSIX, or the tree rooted at `pid` on Windows. */
export async function terminateTree(
  pid: number,
  posixSignal: NodeJS.Signals = 'SIGKILL'
): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid);
    return;
  }
  try {
    process.kill(-pid, posixSignal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function terminateWindowsTree(
  pid: number,
  taskkill: (pid: number) => Promise<unknown> = runTaskkill
): Promise<void> {
  try {
    await taskkill(pid);
  } catch (error) {
    // taskkill's exit code does not say whether the tree survived: 128 means the root was
    // already gone, and 255 can mean the root exited while its children were being ended.
    // A root that no longer exists is the only proof that is not taskkill's prose.
    if (!isPidProvablyGone(pid)) throw error;
  }
}

function runTaskkill(pid: number): Promise<unknown> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return execFileAsync(
    join(systemRoot, 'System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, timeout: 5_000 }
  );
}
