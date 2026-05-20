/**
 * Subprocess execution with process-tree kill on timeout.
 *
 * Node's built-in `execFile` timeout only signals the direct child. Wrapper runtimes
 * (uv, bun run, npm run) fork the real interpreter as a grandchild, which survives
 * the parent's SIGTERM. This module spawns with `detached: true` and sends signals
 * to `-pid` (the entire process group) on POSIX so that grandchildren are also
 * terminated. On Windows (no POSIX process groups), `taskkill /T /F /PID <pid>` is
 * used to walk the process tree and force-kill all descendants.
 *
 * Exported as a method on an object so tests can `spyOn(subprocess, 'exec')`.
 */
import { spawn } from 'node:child_process';

/** Grace period before SIGKILL after initial SIGTERM on timeout (5 seconds) */
const PROCESS_GROUP_KILL_GRACE_MS = 5_000;

/** Maximum bytes to capture from stdout + stderr combined (matches Node execFile default) */
export const MAX_CAPTURE_BYTES = 1_048_576; // 1 MiB

const IS_WINDOWS = process.platform === 'win32';

interface SubprocessError extends Error {
  killed: boolean;
  // string codes (e.g. 'ERR_MAXBUFFER', 'ENOENT') match Node's child_process error
  // shape; numeric codes carry the actual exit status.
  code: number | string | null;
  signal: string | null;
  stderr: string;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    // POSIX process groups don't exist on Windows, and `process.kill(pid, ...)`
    // there maps to TerminateProcess on the wrapper alone — descendants
    // (typically the real interpreter spawned by `uv run` / `bun run`) keep
    // running. Use taskkill /T so the entire tree gets the request: in the
    // SIGTERM phase without /F (taskkill sends WM_CLOSE and a CTRL_C_EVENT
    // to console children, the documented graceful path) and in the SIGKILL
    // phase with /F to force-kill any survivor.
    const args =
      signal === 'SIGKILL' ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T'];
    const child = spawn('taskkill', args, {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {
      // taskkill missing or failed — process may already be dead. The
      // dag-executor surfaces the parent timeout/exit error to the user, so a
      // silent swallow here is fine.
    });
    return;
  }
  process.kill(-pid, signal);
}

interface ExecOptions {
  cwd: string;
  timeout: number;
  env?: NodeJS.ProcessEnv;
}

function execWithProcessGroupKill(
  cmd: string,
  args: string[],
  options: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      // POSIX: detached creates a new process group rooted at child.pid so we can
      // signal -pid. Windows: detached has different semantics (no console attach);
      // we don't need a process group there because taskkill /T walks the tree by pid.
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: IS_WINDOWS,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let capturedBytes = 0;
    let capturedExceeded = false;

    function onCaptureExceeded(): void {
      if (capturedExceeded) return;
      capturedExceeded = true;
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          killProcessTree(pid, 'SIGKILL');
        } catch {
          // Process may have already exited
        }
      }
    }

    // Saturation handling: a chunk landing exactly on MAX_CAPTURE_BYTES is fine
    // (everything captured), but we must catch the *next* incoming chunk so the
    // process is killed and the close handler classifies as ERR_MAXBUFFER. The
    // early-return `>=` branch is the saturation trip wire; the inner `>` keeps
    // exact-fit chunks intact instead of slicing them.
    child.stdout.on('data', (chunk: Buffer) => {
      if (capturedBytes >= MAX_CAPTURE_BYTES) {
        onCaptureExceeded();
        return;
      }
      if (capturedBytes + chunk.length > MAX_CAPTURE_BYTES) {
        stdout += chunk.toString('utf-8', 0, MAX_CAPTURE_BYTES - capturedBytes);
        capturedBytes = MAX_CAPTURE_BYTES;
        onCaptureExceeded();
        return;
      }
      capturedBytes += chunk.length;
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (capturedBytes >= MAX_CAPTURE_BYTES) {
        onCaptureExceeded();
        return;
      }
      if (capturedBytes + chunk.length > MAX_CAPTURE_BYTES) {
        stderr += chunk.toString('utf-8', 0, MAX_CAPTURE_BYTES - capturedBytes);
        capturedBytes = MAX_CAPTURE_BYTES;
        onCaptureExceeded();
        return;
      }
      capturedBytes += chunk.length;
      stderr += chunk.toString();
    });

    const timeoutTimer = setTimeout(() => {
      killed = true;
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          killProcessTree(pid, 'SIGTERM');
        } catch {
          // Process may have already exited
        }
        // SIGKILL grace timer: if the wrapper or any descendant outlives
        // SIGTERM, escalate. Critically, before sending the deferred kill we
        // probe the process group with signal 0 (POSIX) — that way a busy
        // host that recycled the PID into an unrelated group while we waited
        // doesn't get a stray SIGKILL on someone else. On Windows the helper
        // already only fires `taskkill /T /F` for SIGKILL, and reuse there is
        // less of a concern because we walk by PID rather than by group.
        killTimer = setTimeout(() => {
          try {
            if (!IS_WINDOWS) {
              // signal 0 throws ESRCH if the pgid is empty / no longer ours.
              process.kill(-pid, 0);
            }
            killProcessTree(pid, 'SIGKILL');
          } catch {
            // Group already gone (or recycled) — don't risk killing a stranger.
          }
        }, PROCESS_GROUP_KILL_GRACE_MS);
      }
    }, options.timeout);

    child.on('error', (err: Error) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timeoutTimer);
      // Preserve the SIGKILL fallback only when the wrapper closed for reasons
      // unrelated to the timeout. On timeout (killed=true), let the grace
      // timer run so a descendant that ignored SIGTERM is still force-killed.
      // The kill callback itself probes the pgid with signal 0 first, so a
      // recycled PID won't catch a stray kill.
      if (!killed && killTimer) clearTimeout(killTimer);

      // Timeout takes precedence over ERR_MAXBUFFER: a workflow that times out
      // *and* over-produces output is fundamentally a timeout from the engine's
      // perspective, and the dag-executor maps timeout to a different failure
      // category. Misclassifying it as a buffer error would surprise downstream.
      if (killed) {
        const err = new Error(`Command timed out after ${options.timeout}ms`) as SubprocessError;
        err.killed = true;
        err.code = code;
        err.signal = signal ?? 'SIGTERM';
        err.stderr = stderr;
        reject(err);
        return;
      }

      if (capturedExceeded) {
        // Distinct from a timeout: leave `killed` false so dag-executor's
        // `err.killed === true` timeout heuristic doesn't misclassify a
        // buffer-overflow termination and steer users at increasing timeouts
        // when the real fix is to reduce output volume.
        const err = new Error(
          `Command output exceeded ${MAX_CAPTURE_BYTES} bytes and was terminated`
        ) as SubprocessError;
        err.killed = false;
        err.code = 'ERR_MAXBUFFER';
        err.signal = signal ?? 'SIGKILL';
        err.stderr = stderr;
        reject(err);
        return;
      }

      if (code !== 0) {
        const err = new Error(`Command failed with exit code ${String(code)}`) as SubprocessError;
        err.killed = false;
        err.code = code;
        err.signal = signal;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Exported as an object so tests can spyOn(subprocess, 'exec') */
export const subprocess = {
  exec: execWithProcessGroupKill,
};
