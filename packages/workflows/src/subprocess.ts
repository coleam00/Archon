import { spawn } from 'node:child_process';
import { terminateTree } from '@archon/paths/plugin-process';
import { retainStreamTail } from './executor-shared';
import type { ExecutionContext } from '@archon/provider-contract';
import { CONTAINER_ENV_DENYLIST } from '@archon/provider-contract';
import { execFileAsync } from '@archon/git';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';
import { logExecOutput } from './logger';

export { retainStreamTail } from './executor-shared';

/**
 * Reduce a host-resolved command to the name the container image exposes on
 * PATH: strip any directory (a host absolute path like the Windows Git-Bash
 * `bash.exe` doesn't exist in the Linux runner) and a trailing `.exe`. `bash`,
 * `bun`, and `uv` all live on the runner image's PATH.
 */
export function containerCommandName(cmd: string): string {
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd;
  return base.replace(/\.exe$/i, '');
}

/**
 * Build the `docker exec` argv for a deterministic subprocess (bash/script) in a
 * container. Env is delivered ONLY via `-e` flags (never merged with the docker
 * CLI's own env / host process.env — the isolation invariant); the command name
 * is normalized to the in-container binary. Exported for the env-isolation
 * enforcement test.
 */
export function buildSubprocessDockerArgs(
  execContext: Extract<ExecutionContext, { kind: 'container' }>,
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): string[] {
  const dockerArgs = ['exec', '-w', options.cwd];
  if (execContext.execUser) dockerArgs.push('-u', execContext.execUser);
  for (const [key, value] of Object.entries(options.env)) {
    // Skip the denylist (PATH/HOME/…): a project env var must not clobber the
    // in-container binary/home resolution — same policy as the Claude spawn path.
    if (value === undefined || CONTAINER_ENV_DENYLIST.has(key)) continue;
    dockerArgs.push('-e', `${key}=${value}`);
  }
  dockerArgs.push(execContext.containerId, containerCommandName(cmd), ...args);
  return dockerArgs;
}

/** Subprocess failure evidence, including execFile timeout and exit fields. */
export type RawSubprocessRejection = Error & {
  stdout?: string;
  stderr?: string;
  cmd?: string;
  spawnargs?: string[];
  /**
   * Numeric exit code, or a symbol (`'ENOENT'`, `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`).
   * `null` on a timeout kill — Node reports that one through `signal` instead.
   */
  code?: number | string | null;
  /** True when Node killed the child after the configured `execFile` timeout elapsed. */
  killed?: boolean;
  /** The owned group deadline expired, independent of the eventual exit code. */
  timedOut?: boolean;
  /** Terminal signal, also present when a command terminates itself. */
  signal?: string | null;
};

export function isSubprocessTimeout(error: RawSubprocessRejection): boolean {
  return error.timedOut === true || (error.killed === true && error.code === null);
}

/**
 * Scrub credentials from every subprocess rejection field that can carry
 * subprocess text. The exact values come from the engine's injected-credential
 * provenance plus secret-named project env entries, so provider credentials are
 * removed even when the failed process echoes them without their env key.
 *
 * Mutates in place rather than returning a fresh Error: callers classify the
 * rejection by reading `timedOut`/`killed` and `code` (ENOENT/EACCES) off
 * the original object, and a replacement would silently drop those and turn every
 * timeout into a generic failure.
 *
 * `cmd` and `spawnargs` are not redundant with `message`. They can be the only
 * carriers when the rejection
 * is not a non-zero exit: a maxBuffer overflow rejects with `message` = 'stdout
 * maxBuffer length exceeded' — no argv at all — so the credentials survive solely
 * in `cmd`. Pino serializes every enumerable `err` property, so an unredacted `cmd`
 * writes the token to the detached-run log even when `message` is already clean.
 */
export function redactSubprocessError(
  e: RawSubprocessRejection,
  credentialValues: readonly string[]
): RawSubprocessRejection {
  e.message = redactCredentialValues(e.message, credentialValues);
  if (e.stack) e.stack = redactCredentialValues(e.stack, credentialValues);
  if (typeof e.stdout === 'string') {
    e.stdout = redactCredentialValues(e.stdout, credentialValues);
  }
  if (typeof e.stderr === 'string') {
    e.stderr = redactCredentialValues(e.stderr, credentialValues);
  }
  if (typeof e.cmd === 'string') e.cmd = redactCredentialValues(e.cmd, credentialValues);
  if (Array.isArray(e.spawnargs)) {
    e.spawnargs = e.spawnargs.map(arg => redactCredentialValues(arg, credentialValues));
  }
  return e;
}

interface SubprocessRetention {
  logDir: string;
  workflowRunId: string;
  /**
   * Transcript step id. Loop probes use `<node>-iteration-<i>`, matching the loop's own
   * transcript rows.
   *
   * A node body uses the bare `node.id`, NOT the namespaced `stepName` the persisted
   * events carry. That is a deliberate trade: it keeps this row correlated with the
   * `node_start`/`node_complete` rows beside it, which have always used the bare id, at
   * the cost of collapsing fan-out instances and loop_group body iterations of one node
   * onto the same `step` — those are then told apart by row order.
   */
  nodeId: string;
  label: string;
}

/**
 * Run a deterministic subprocess (bash/script node body, loop `until_bash`) under
 * the given execution context.
 *
 * `options.env` is the ARCHON-MANAGED env only (node vars + codebase env + creds)
 * — NEVER pre-merged with `process.env`. The host path layers it over the
 * (already-cleaned) host `process.env`, byte-identical to before. The container
 * path delivers ONLY that managed env via `docker exec -e` (host `process.env`
 * never crosses the boundary — the isolation invariant) and runs the command
 * in-container at the same absolute cwd, so `bash:`/`script:` nodes have no
 * host-escape hole.
 */
export async function runSubprocess(
  execContext: ExecutionContext,
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    /** Host setup only: end the group on deadline, command exit, or owner death. */
    ownProcessGroup?: true;
    env: NodeJS.ProcessEnv;
    protectedEnvKeys?: readonly string[];
    protectedCredentialValues?: readonly string[];
    retention: SubprocessRetention | { standalone: true };
  }
): Promise<{ stdout: string; stderr: string; credentialValues: readonly string[] }> {
  if (options.ownProcessGroup && execContext.kind === 'container') {
    throw new Error('Owned subprocess groups require host execution');
  }
  const subprocessEnv =
    execContext.kind === 'container' ? options.env : { ...process.env, ...options.env };
  // Both outcomes redact against the same values, so the credential set is resolved
  // once here rather than separately per path — a success path that redacted less than
  // the failure path would be the security hole, not a style difference.
  const credentialValues = collectCredentialValues(
    subprocessEnv,
    options.protectedEnvKeys,
    options.protectedCredentialValues
  );
  const retention = options.retention;
  // Container env is delivered in argv, while either execution mode can echo a
  // credential in output. Sanitize at the shared boundaries below so every downstream
  // reader — the rejection's consumers and the retained evidence alike — sees the same
  // safe text.
  try {
    const result =
      execContext.kind === 'container'
        ? await execFileAsync(
            'docker',
            buildSubprocessDockerArgs(execContext, cmd, args, {
              cwd: options.cwd,
              env: options.env,
            }),
            { timeout: options.timeout }
          )
        : options.ownProcessGroup
          ? await execOwnedProcessGroup(cmd, args, {
              cwd: options.cwd,
              timeout: options.timeout,
              env: subprocessEnv,
            })
          : await execFileAsync(cmd, args, {
              cwd: options.cwd,
              timeout: options.timeout,
              env: subprocessEnv,
            });

    result.stderr = redactCredentialValues(result.stderr, credentialValues);
    // Retention is the EVIDENCE copy, taken from a redacted-then-capped copy of the
    // streams. The caller's `stdout` remains the node's full-fidelity value channel
    // (#2726), while `stderr` shares the exact redacted copy used for retention because
    // callers broadcast it to the operator.
    if (!('standalone' in retention))
      await logExecOutput(
        retention.logDir,
        retention.workflowRunId,
        retention.nodeId,
        retention.label,
        {
          stdoutTail: retainStreamTail(redactCredentialValues(result.stdout, credentialValues)),
          stderrTail: retainStreamTail(result.stderr),
          exitCode: 0,
        }
      );
    // `credentialValues` rides along so a caller that quotes stdout back (a contract
    // failure's preview) redacts against exactly this set rather than resolving its own.
    return { ...result, credentialValues };
  } catch (err) {
    const rejection = redactSubprocessError(err as RawSubprocessRejection, credentialValues);
    // `redactSubprocessError` already scrubbed these fields in place, so retention reads
    // the same safe values every other failure consumer sees.
    if (!('standalone' in retention))
      await logExecOutput(
        retention.logDir,
        retention.workflowRunId,
        retention.nodeId,
        retention.label,
        {
          stdoutTail: retainStreamTail(rejection.stdout),
          stderrTail: retainStreamTail(rejection.stderr),
          // A timeout kill reports `code: null` and names the signal instead. An
          // `until_bash` probe has no sibling `node_error` row to say so, and a probe that
          // was killed is exactly the case a reader needs distinguished from one that
          // simply answered "not yet".
          exitCode: rejection.code ?? rejection.signal ?? 'unknown',
        }
      );
    throw rejection;
  }
}

// Explicit <&0 keeps bash from replacing the background watcher's stdin with /dev/null.
// Only the owner holds the write end; EOF covers even SIGKILL, without signal handlers.
const SETUP_LIFELINE =
  '{ while IFS= read -r; do :; done; kill -KILL 0; } <&0 >/dev/null 2>&1 &\n"$@" </dev/null';
const TERMINATION_CONFIRM_MS = 1000;

async function confirmGroupGone(pid: number): Promise<void> {
  const deadline = Date.now() + TERMINATION_CONFIRM_MS;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      if (code !== 'EPERM') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Setup process group ${pid} is still running`);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

async function execOwnedProcessGroup(
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const posix = process.platform !== 'win32';
  const child = spawn(cmd, posix ? ['-c', SETUP_LIFELINE, 'archon-setup', cmd, ...args] : args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: posix,
    stdio: [posix ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const maxBuffer = 1024 * 1024;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let failure: RawSubprocessRejection | undefined;
  let timedOut = false;
  let exited = false;
  let termination: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const stop = (): void => {
    // Never signal a group after its leader exited: that PID may already be reused.
    if (termination || exited || child.pid === undefined) return;
    termination = terminateTree(child.pid).catch((error: unknown) => {
      terminationError = error instanceof Error ? error : new Error(String(error));
    });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    child.stdout?.destroy();
    child.stderr?.destroy();
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
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
  child.once('error', error => {
    failure = error;
  });
  child.once('exit', () => {
    exited = true;
    // The watcher ends leftovers from inside its group, without a stale-PID signal.
    child.stdin?.destroy();
  });
  const closed = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  child.stdin?.destroy();
  await termination;
  if (posix && child.pid !== undefined) {
    try {
      await confirmGroupGone(child.pid);
    } catch (error) {
      terminationError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (terminationError) {
    failure ??= new Error('Setup process group termination failed');
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
