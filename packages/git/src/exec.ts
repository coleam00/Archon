import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir as fsMkdir } from 'fs/promises';
import { promisify } from 'util';

const promisifiedExecFile = promisify(execFile);

/**
 * Resolve the bash binary path in a platform-aware way.
 *
 * On Windows, CreateProcess searches System32 BEFORE PATH, so a bare
 * `spawn('bash', ...)` resolves to `C:\Windows\System32\bash.exe` (the WSL
 * launcher). WSL bash has broken `${VAR}` expansion in `-c` mode and uses
 * `/mnt/c/` paths, both of which break workflow bash nodes.
 *
 * Fix: on Windows, default to the Git Bash absolute path. `ARCHON_BASH_PATH`
 * overrides for non-standard installs (e.g. user-scope at
 * `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`). The override is eagerly
 * validated via `existsSync` so typos surface immediately instead of as an
 * opaque ENOENT inside the first bash-node fire.
 */
export function resolveBashPath(): string {
  const override = process.env.ARCHON_BASH_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `ARCHON_BASH_PATH points to a path that does not exist: '${override}'. ` +
          'Either unset the env var to fall back to the platform default, or correct the path ' +
          '(on Windows, a common user-scope Git install path is ' +
          "'%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe')."
      );
    }
    return override;
  }
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
