import { execFile } from 'node:child_process';
import { extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function validateCommand(command: string): string | undefined {
  if (!isAbsolute(command)) return 'plugin command must be an absolute executable path';
  const extension = extname(command).toLowerCase();
  if (extension === '.cmd' || extension === '.bat')
    return 'plugin command cannot be a .cmd or .bat file';
  if (process.platform === 'win32' && extension !== '.exe')
    return 'Windows plugin command must be an .exe file';
  return undefined;
}

export async function terminateTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
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
    if (!isProcessGone(pid)) throw error;
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

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid exists under another user; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
