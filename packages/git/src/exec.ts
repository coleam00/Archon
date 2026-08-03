import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir as fsMkdir } from 'fs/promises';
import { promisify } from 'util';

const promisifiedExecFile = promisify(execFile);

/**
 * Common Git-Bash install locations on Windows, scanned in order when
 * `ARCHON_BASH_PATH` is unset. Covers the system-wide installer (also the
 * choco `git.install` target), the 32-bit installer, the user-scope
 * installer, and scoop.
 */
function windowsGitBashCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  return [
    `${programFiles}\\Git\\bin\\bash.exe`,
    `${programFiles}\\Git\\usr\\bin\\bash.exe`,
    `${programFilesX86}\\Git\\bin\\bash.exe`,
    ...(localAppData ? [`${localAppData}\\Programs\\Git\\bin\\bash.exe`] : []),
    ...(userProfile ? [`${userProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe`] : []),
  ];
}

/**
 * Resolve the bash binary path in a platform-aware way.
 *
 * On Windows, CreateProcess searches System32 BEFORE PATH, so a bare
 * `spawn('bash', ...)` resolves to `C:\Windows\System32\bash.exe` (the WSL
 * launcher). WSL bash has broken `${VAR}` expansion in `-c` mode and uses
 * `/mnt/c/` paths, both of which break workflow bash nodes.
 *
 * Fix: on Windows, scan the common Git-Bash install locations and use the
 * first that exists. `ARCHON_BASH_PATH` overrides for non-standard installs.
 * The override is eagerly validated via `existsSync` so typos surface
 * immediately instead of as an opaque ENOENT inside the first bash-node fire.
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
    for (const candidate of windowsGitBashCandidates()) {
      if (existsSync(candidate)) return candidate;
    }
    // No candidate exists (Git for Windows not installed, or installed
    // somewhere unusual). Intentional fallback: return the canonical default
    // rather than throwing here, so the exec-site error message names a
    // concrete path alongside the ARCHON_BASH_PATH hint.
    return `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\bash.exe`;
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
