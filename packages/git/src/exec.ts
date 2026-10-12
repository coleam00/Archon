import { terminateTree } from '@archon/paths/plugin-process';
import { execFile, spawn } from 'child_process';
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
    /** Await forced process-tree termination when the deadline expires. */
    processTreeTimeout?: boolean;
  }
): Promise<{ stdout: string; stderr: string }> {
  const { processTreeTimeout, ...execOptions } = options ?? {};
  if (processTreeTimeout && execOptions.timeout) {
    return execFileWithProcessTreeTimeout(cmd, args, {
      ...execOptions,
      timeout: execOptions.timeout,
    });
  }
  const result = await promisifiedExecFile(cmd, args, { windowsHide: true, ...execOptions });
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

async function execFileWithProcessTreeTimeout(
  cmd: string,
  args: string[],
  options: Omit<NonNullable<Parameters<typeof execFileAsync>[2]>, 'processTreeTimeout'> & {
    timeout: number;
  }
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide ?? true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let failure: Error | undefined;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const stop = (): void => {
    if (termination) return;
    termination =
      child.pid === undefined
        ? Promise.resolve()
        : terminateTree(child.pid).catch((error: unknown) => {
            terminationError = error instanceof Error ? error : new Error(JSON.stringify(error));
          });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeout);
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const previous = stream === 'stdout' ? stdout : stderr;
    const buffer = Buffer.concat([previous, chunk.subarray(0, maxBuffer - previous.length)]);
    if (stream === 'stdout') stdout = buffer;
    else stderr = buffer;
    if (previous.length + chunk.length > maxBuffer && !failure) {
      failure = Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      clearTimeout(timer);
      stop();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    collect('stdout', chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    collect('stderr', chunk);
  });
  child.on('error', error => {
    failure = error;
  });
  const closed = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  clearTimeout(timer);
  await termination;
  if (terminationError !== undefined) {
    failure ??= new Error(`Command failed: ${cmd} ${args.join(' ')}`);
    failure.message += `; could not terminate subprocess tree: ${terminationError.message}`;
  }
  const output = { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  if (timedOut || failure || closed.code !== 0) {
    throw Object.assign(
      failure ??
        new Error(
          timedOut
            ? `Command timed out after ${options.timeout} ms`
            : `Command failed: ${cmd} ${args.join(' ')}\n${output.stderr}`
        ),
      {
        ...output,
        ...(!failure ? { code: closed.code } : {}),
        signal: closed.signal,
        timedOut,
        cmd: `${cmd} ${args.join(' ')}`,
        spawnargs: args,
      }
    );
  }
  return output;
}

/** Wrapper around fs.mkdir for test mockability */
export async function mkdirAsync(path: string, options?: { recursive?: boolean }): Promise<void> {
  await fsMkdir(path, options);
}
