/**
 * Claude-in-container spawn hook.
 *
 * Implements the Claude Agent SDK's `spawnClaudeCodeProcess` option so the CLI
 * runs INSIDE a prepared isolation container via `docker exec -i`, rather than
 * on the host. The SDK bypasses its own disk resolution entirely when this hook
 * is set (so `pathToClaudeCodeExecutable` is intentionally omitted for container
 * runs) and drives the returned {@link SpawnedProcess} over stdin/stdout exactly
 * as it would a local child.
 *
 * The one thing a plain `ChildProcess` gets wrong across the docker boundary is
 * signalling: `child.kill()` signals the LOCAL `docker exec` client, which does
 * NOT forward the signal to the process inside the container (docker/cli#2607).
 * So `kill()` is overridden to signal the in-container Claude process directly
 * via a second `docker exec ... pkill`.
 *
 * v1 is Claude-only. Codex/Pi/community providers latch on here by implementing
 * their own `ExecutionContext`-aware spawn/transport (see the provider support
 * matrix in the plan) — the `containerExec` capability + the engine's
 * pre-dispatch fail-fast are the extension seam.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionContext } from '../types';
import { CONTAINER_ENV_DENYLIST } from '../types';
import { createLogger } from '@archon/paths';

/**
 * Process spawner, injectable so `buildContainerSpawn` can be unit-tested with a
 * fake child (DI, not `mock.module` — keeps this out of a mock-pollution batch).
 * Defaults to `child_process.spawn`.
 */
export type Spawner = (
  command: string,
  args: string[],
  options: { stdio: unknown }
) => ChildProcess;

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.claude.container');
  return cachedLog;
}

/**
 * In-container Claude binary. Resolved via the runner image's PATH
 * (/root/.local/bin), overridable for non-standard images.
 */
const CONTAINER_CLAUDE_BIN = process.env.ARCHON_CONTAINER_CLAUDE_BIN ?? 'claude';

// Env keys never forwarded via `docker exec -e` — shared with the bash/script
// exec path (see `@archon/providers/types`) so the two container env policies
// can't drift.

/** Build the per-invocation in-container pidfile path. Uuid-only → shell-safe. */
function pidFilePath(): string {
  return `/tmp/archon-claude-${randomUUID()}.pid`;
}

/**
 * Build `docker exec` argv for running Claude inside the container. Exported for
 * unit testing the argument construction without spawning a process.
 *
 * Claude is wrapped in a pid-capturing shell: `$$` is the sh PID, and
 * `exec claude "$@"` replaces sh IN PLACE, so Claude inherits that same PID —
 * which the wrapper writes to `pidFile`. That lets `kill()` target THIS
 * invocation's Claude, NOT sibling Claude nodes sharing the run container
 * (concurrent DAG layers). The SDK args ride `"$@"`, so they are passed as argv
 * (no shell interpolation / injection).
 */
export function buildDockerExecArgs(
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  options: SpawnOptions,
  pidFile: string
): string[] {
  const args = ['exec', '-i'];
  if (execContext.execUser) args.push('-u', execContext.execUser);
  if (options.cwd) args.push('-w', options.cwd);
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined || CONTAINER_ENV_DENYLIST.has(key)) continue;
    args.push('-e', `${key}=${value}`);
  }
  args.push(
    execContext.containerId,
    'sh',
    '-c',
    `echo $$ > ${pidFile}; exec ${CONTAINER_CLAUDE_BIN} "$@"`,
    CONTAINER_CLAUDE_BIN, // $0 (cosmetic — "$@" starts at the real SDK args below)
    ...options.args
  );
  return args;
}

/** Strip Node's `SIG` prefix for `kill` (which takes `TERM`/`KILL`). */
function toPosixSignal(signal: NodeJS.Signals): string {
  return signal.replace(/^SIG/, '');
}

/**
 * Kill exactly THIS invocation's in-container Claude via its pidfile (not sibling
 * Claude nodes — the old `pkill -f claude` killed every Claude in the container).
 * Signals the process group first (children: bash tool subprocesses) then the pid
 * itself; both best-effort (pidfile may not be written yet, or the pid gone).
 * Fire-and-forget: teardown failures are logged, never thrown.
 */
function killInContainer(
  containerId: string,
  signal: NodeJS.Signals,
  spawnFn: Spawner,
  pidFile: string
): void {
  const posix = toPosixSignal(signal);
  const script =
    `pid=$(cat ${pidFile} 2>/dev/null); ` +
    `[ -n "$pid" ] && { kill -${posix} -"$pid" 2>/dev/null; kill -${posix} "$pid" 2>/dev/null; }; ` +
    'true';
  const killer = spawnFn('docker', ['exec', containerId, 'sh', '-c', script], { stdio: 'ignore' });
  killer.on('error', err => {
    getLog().warn({ containerId, signal: posix, err }, 'claude.container_kill_failed');
  });
}

/**
 * Create the SDK spawn hook for a container execution context.
 *
 * The returned function spawns `docker exec -i` for each SDK-driven Claude run
 * and wraps the resulting child as a {@link SpawnedProcess}: stdio piped
 * (force-pipe is inherent to `-i` with no `-t`), stderr inherited for
 * visibility, `kill()` redirected into the container, and the SDK's forwarded
 * abort `signal` (which fires only after the SDK's stdin-EOF + grace window)
 * force-killing in-container.
 */
export function buildContainerSpawn(
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  spawnFn: Spawner = spawn as unknown as Spawner
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    // Per-invocation pidfile so kill() targets only this Claude, not siblings.
    const pidFile = pidFilePath();
    const dockerArgs = buildDockerExecArgs(execContext, options, pidFile);
    getLog().debug(
      { containerId: execContext.containerId, argc: options.args.length },
      'claude.container_spawn_started'
    );

    // stderr inherited: the SpawnedProcess contract exposes only stdin/stdout, so
    // the SDK can't read the child's stderr — inheriting surfaces container-side
    // Claude errors in Archon's own stderr instead of swallowing them. The
    // 'pipe','pipe','inherit' stdio makes stdin/stdout non-null.
    const child = spawnFn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    // The 'pipe','pipe' stdio guarantees stdin/stdout are present; guard rather
    // than assert so a misbehaving spawner fails loudly instead of NPE-ing later.
    if (!child.stdin || !child.stdout) {
      throw new Error('docker exec child is missing piped stdin/stdout');
    }

    // Force-kill in-container when the SDK's forwarded abort fires (post-grace).
    const onAbort = (): void => {
      killInContainer(execContext.containerId, 'SIGKILL', spawnFn, pidFile);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const wrapped: SpawnedProcess = {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed(): boolean {
        return child.killed;
      },
      get exitCode(): number | null {
        return child.exitCode;
      },
      kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        // Default matches ChildProcess.kill() (no-arg → SIGTERM); without it a
        // no-arg kill() would pass undefined into toPosixSignal and crash.
        // Signal the in-container process (the local docker-exec kill would not
        // cross the boundary), then tear down the local exec client too.
        killInContainer(execContext.containerId, signal, spawnFn, pidFile);
        return child.kill(signal);
      },
      on(event: 'exit' | 'error', listener: (...eventArgs: never[]) => void): void {
        child.on(event, listener as never);
      },
      once(event: 'exit' | 'error', listener: (...eventArgs: never[]) => void): void {
        child.once(event, listener as never);
      },
      off(event: 'exit' | 'error', listener: (...eventArgs: never[]) => void): void {
        child.off(event, listener as never);
      },
    };

    return wrapped;
  };
}
