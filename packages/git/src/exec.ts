import { realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { GitFailure, type GitFailureKind } from './errors';
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

async function isMissingPath(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Whether Git's own discovery from `path` would reach a `.git` entry or a bare
 * repository. The walk stops where Git's does: before entering a
 * `GIT_CEILING_DIRECTORIES` entry, and at a filesystem boundary unless
 * `GIT_DISCOVERY_ACROSS_FILESYSTEM` is set. A marker beyond either is not one
 * Git saw, so it must not turn absence into a repository failure.
 */
async function hasRepositoryMarker(path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const ceilings = new Set(
    await Promise.all(
      (env.GIT_CEILING_DIRECTORIES ?? '')
        .split(delimiter)
        .filter(entry => isAbsolute(entry))
        .map(entry => realpath(entry).catch(() => entry))
    )
  );
  const acrossFilesystems = ['1', 'true', 'yes', 'on'].includes(
    (env.GIT_DISCOVERY_ACROSS_FILESYSTEM ?? '').toLowerCase()
  );
  let current = await realpath(path);
  const device = (await stat(current)).dev;
  while (true) {
    if (await hasRepositoryMarkerAt(current)) return true;
    const parent = dirname(current);
    if (parent === current || ceilings.has(parent)) return false;
    if (!acrossFilesystems && (await stat(parent)).dev !== device) return false;
    current = parent;
  }
}

async function hasRepositoryMarkerAt(path: string): Promise<boolean> {
  for (const marker of ['.git', 'HEAD']) {
    try {
      const entry = await stat(join(path, marker));
      if (marker === '.git') return true;
      if (entry.isFile() && (await stat(join(path, 'objects'))).isDirectory()) return true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function classifyGitFailure(
  cause: unknown,
  args: string[],
  options: Parameters<typeof execFileAsync>[2]
): Promise<GitFailureKind> {
  let kind: GitFailureKind = 'unclassified';
  if (
    cause instanceof Error &&
    'killed' in cause &&
    cause.killed === true &&
    'code' in cause &&
    cause.code === null &&
    options?.timeout
  )
    kind = 'timeout';
  const path = args[0] === '-C' ? args[1] : options?.cwd;
  const env = options?.env ?? process.env;
  if (
    path &&
    cause instanceof Error &&
    'code' in cause &&
    (cause.code === 128 || cause.code === 'ENOENT') &&
    !env.GIT_DIR
  ) {
    try {
      // A vanished start path fails `-C` with exit 128 and `cwd` with a spawn
      // ENOENT; either way no repository is there.
      if (await isMissingPath(path)) kind = 'not_repository';
      else if (cause.code === 128 && !(await hasRepositoryMarker(path, env))) {
        // Repository discovery also exits 128 for invalid configuration. Verify
        // Git can load its configuration before treating absence as the cause.
        await promisifiedExecFile('git', ['-C', path, 'config', '--list', '--name-only'], {
          windowsHide: true,
          ...options,
        });
        kind = 'not_repository';
      }
    } catch {
      // Failed inspection leaves the original Git evidence unclassified.
    }
  }
  return kind;
}

/**
 * Wrapper around child_process.execFile for test mockability.
 *
 * `windowsHide` DEFAULTS TO TRUE, and that default is the whole point of it living
 * here rather than at the call sites.
 *
 * A detached workflow run (`--detach`) is spawned with `detached: true`, which on
 * Windows means DETACHED_PROCESS: the run owner has NO console at all. Every console
 * program it then launches -- git above all, but also `uv`, `bun` and bash nodes --
 * is therefore given a BRAND NEW console by the OS. When Windows Terminal is the
 * default console host, "a new console" is a real terminal window that opens on the
 * user's desktop, takes focus, and closes a second later.
 *
 * Archon calls git several times per node (the `mutates_checkout` status snapshot,
 * worktree plumbing), so an unattended factory loop flashed a window every few
 * seconds for hours. CREATE_NO_WINDOW -- which is what `windowsHide` sets -- gives
 * the child a console it can still write to, with no window attached.
 *
 * It is a DEFAULT rather than a hard-coded true so a caller that genuinely needs a
 * visible console (an interactive prompt) can still opt out by passing false.
 */
export async function execFileAsync(
  cmd: string,
  args: string[],
  options?: {
    timeout?: number;
    cwd?: string;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    windowsHide?: boolean;
    killSignal?: NodeJS.Signals;
    input?: string;
  }
): Promise<{ stdout: string; stderr: string }> {
  const { input, ...execOptions } = options ?? {};
  const pending = promisifiedExecFile(cmd, args, { windowsHide: true, ...execOptions });
  let inputError: Error | undefined;
  if (input !== undefined) {
    pending.child.stdin?.on('error', error => {
      inputError = error;
    });
    pending.child.stdin?.end(input, 'utf8');
  }
  const result = await pending.catch(async (cause: unknown) => {
    if (cause instanceof TypeError || cause instanceof RangeError) throw cause;
    if (cmd !== 'git') throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    const kind = await classifyGitFailure(cause, args, execOptions);
    throw new GitFailure(kind, detail, cause);
  });
  if (inputError) throw Object.assign(inputError, { stdout: result.stdout, stderr: result.stderr });
  // The `.toString()` these two lines used to carry is gone deliberately. Passing an
  // options OBJECT unconditionally (rather than possibly `undefined`) resolves
  // execFile to its string-encoding overload, so both fields are already strings and
  // the conversion became provably redundant -- which is what the type-aware lint rule
  // reported. Node defaults execFile's encoding to utf8, so this is the same value.
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Wrapper around fs.mkdir for test mockability */
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}
