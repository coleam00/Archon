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
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    try {
      await execFileAsync(
        join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        {
          windowsHide: true,
          timeout: 5_000,
        }
      );
    } catch (error) {
      // taskkill exits 128 when the process is already gone: the win32 ESRCH. A child can
      // exit between its caller's liveness check and this call, e.g. on stdin EOF.
      if ((error as { code?: unknown }).code !== 128) throw error;
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
