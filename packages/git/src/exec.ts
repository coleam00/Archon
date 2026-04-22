import { execFile } from 'child_process';
import { mkdir as fsMkdir } from 'fs/promises';
import { promisify } from 'util';

const promisifiedExecFile = promisify(execFile);

/**
 * Resolve the bash binary path in a platform-aware way.
 *
 * On Windows, CreateProcess searches the System32 directory BEFORE the PATH
 * env var. Bare `spawn('bash', ...)` therefore resolves to
 * `C:\Windows\System32\bash.exe` (the WSL launcher), whose bash has broken
 * `${VAR}` expansion when invoked in `-c` mode and uses `/mnt/c/` path
 * convention instead of `/c/`. Both break workflow bash nodes.
 *
 * Fix: on Windows, default to the Git Bash absolute path. Overridable via
 * ARCHON_BASH_PATH for non-standard Git installs (e.g. user-scope installer
 * at %LOCALAPPDATA%\Programs\Git\bin\bash.exe).
 *
 * See: coleam00/Archon#1326
 */
export function resolveBashPath(): string {
  if (process.env.ARCHON_BASH_PATH) return process.env.ARCHON_BASH_PATH;
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Git\\bin\\bash.exe';
  }
  return 'bash';
}

/** Wrapper around child_process.execFile for test mockability */
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: { timeout?: number; cwd?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const result = await promisifiedExecFile(cmd, args, options);
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
  };
}

/** Wrapper around fs.mkdir for test mockability */
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}
