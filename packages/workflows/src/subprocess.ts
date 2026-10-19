import { type ChildProcess, spawn } from 'node:child_process';
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
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }
): string[] {
  const dockerArgs = ['exec', '-w', options.cwd];
  if (options.input !== undefined) dockerArgs.push('-i');
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
  /**
   * A node's deadline expired but its process tree could not be ended. That is a failure,
   * never a timeout `on_timeout: skip` could pass over while the tree may still run.
   */
  treeSurvived?: true;
  /** The node's run stopped and its tree was ended for it; never a timeout. */
  cancelled?: true;
  /** Terminal signal, also present when a command terminates itself. */
  signal?: string | null;
};

/**
 * The errno of a host command that could not be spawned. In a container the spawned
 * binary is `docker`, so its spawn errno says nothing about the node's own command.
 */
export function hostSpawnFailure(
  execContext: ExecutionContext,
  error: RawSubprocessRejection
): 'ENOENT' | 'EACCES' | 'ENOTDIR' | undefined {
  if (execContext.kind !== 'host') return undefined;
  const { code } = error;
  return code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR' ? code : undefined;
}

export function isSubprocessTimeout(error: RawSubprocessRejection): boolean {
  if (error.treeSurvived || error.cancelled) return false;
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

interface NodeProcessRecorder {
  /** Each in-flight node's root PID, with the function that disarms its owner-death watcher. */
  roots: Map<number, () => void>;
  ended: boolean;
}
let nodeProcessRecorder: NodeProcessRecorder | undefined;

/**
 * Record the root of every host node subprocess this process starts, so its trees can
 * be ended. Each root leads its own process group on POSIX; `taskkill /T` walks the tree
 * from the PID on Windows. A POSIX root also gets a watcher that ends its group when this
 * process dies.
 *
 * Process-scoped on purpose, because process-group membership belongs to the owning
 * process. Two owners turn this on:
 * - A foreground CLI owner, which drives exactly one run and holds the process-wide
 *   signal handlers for it, ends every tree through `end()` on interrupt, so a resume does
 *   not overlap the interrupted attempt (#3552).
 * - `archon serve` ends one run's trees through each node's `abortSignal` when that run
 *   stops, and never calls `end()`.
 *
 * A detached owner must not record: the cancel controller ends its nodes by killing the
 * owner's process group, which a node in its own group would escape.
 *
 * `end()` refuses every later node subprocess, so a sibling or retry the executor
 * starts while the owner exits never runs.
 */
export function recordNodeProcessTrees(): { end(): Promise<void>; release(): void } {
  const recorder: NodeProcessRecorder = { roots: new Map(), ended: false };
  nodeProcessRecorder = recorder;
  return {
    end: async () => {
      recorder.ended = true;
      const failed: string[] = [];
      await Promise.all(
        [...recorder.roots].map(([pid, disarm]) =>
          terminateTree(pid).then(disarm, (error: unknown) => {
            failed.push(
              `${String(pid)} (${error instanceof Error ? error.message : String(error)})`
            );
          })
        )
      );
      if (failed.length > 0) {
        throw new Error(`could not end node process trees: ${failed.join(', ')}`);
      }
    },
    release: () => {
      if (nodeProcessRecorder === recorder) nodeProcessRecorder = undefined;
    },
  };
}

// A node runs in its own session, so terminal hangup or a second Ctrl-C kills the owner
// without reaching the node, and so does SIGKILL. The watcher sits outside the node's
// group and session: owner death of any kind closes its stdin before the release line.
const NODE_LIFELINE = 'IFS= read -r line || kill -s KILL -- "-$1"';

function armNodeLifeline(pgid: number, onError: (error: Error) => void): () => void {
  const watcher = spawn('/bin/sh', ['-c', NODE_LIFELINE, 'archon-node-lifeline', String(pgid)], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  watcher.unref();
  watcher.once('error', onError);
  // EPIPE only means the watcher already exited, so there is nothing left to disarm.
  watcher.stdin?.on('error', () => undefined);
  return () => {
    watcher.stdin?.end('\n');
  };
}

function recordNodeProcess(
  child: ChildProcess,
  recorder: NodeProcessRecorder | undefined,
  onError: (error: Error) => void
): void {
  const rootPid = child.pid;
  if (!recorder || rootPid === undefined) return;
  const disarm =
    process.platform !== 'win32' ? armNodeLifeline(rootPid, onError) : (): void => undefined;
  recorder.roots.set(rootPid, disarm);
  // The node is in flight until `close`: a root that exits while a background job still
  // holds its output has not settled. `stop` does not signal that group, but the owner's
  // interrupt (`end()`) still can: the kernel does not reuse the root PID while its group
  // exists.
  child.once('close', () => {
    recorder.roots.delete(rootPid);
    disarm();
  });
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
    /** Absent means no deadline: the subprocess runs until it exits. */
    timeout?: number;
    /**
     * A host node body: its deadline ends the node's whole tree before the timeout is
     * reported. On POSIX that needs the node's own process group, which only a recording
     * owner gives it; an unrecorded POSIX node shares its owner's group, which
     * `archon workflow cancel` kills to end a detached run, so its deadline still ends the
     * root only.
     */
    endTreeOnTimeout?: true;
    /**
     * Its run stopped: end the node's whole tree with SIGKILL. Honored only for a recorded
     * host node. An unrecorded (detached) node is ended by its owner's group kill; a
     * container node's command is not ended.
     */
    abortSignal?: AbortSignal;
    env: NodeJS.ProcessEnv;
    protectedEnvKeys?: readonly string[];
    protectedCredentialValues?: readonly string[];
    retention: SubprocessRetention | { standalone: true };
  } & (
    | {
        /** Host setup: stdin belongs to the owner-death lifeline, never a payload. */
        ownProcessGroup?: true;
        input?: never;
      }
    | { ownProcessGroup?: never; input?: string }
  )
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
              input: options.input,
            }),
            { timeout: options.timeout, input: options.input }
          )
        : options.ownProcessGroup
          ? await execOwnedProcessGroup(cmd, args, {
              cwd: options.cwd,
              timeout: options.timeout,
              env: subprocessEnv,
            })
          : nodeProcessRecorder || (options.endTreeOnTimeout && process.platform === 'win32')
            ? await execOwnedProcessGroup(cmd, args, {
                cwd: options.cwd,
                timeout: options.timeout,
                env: subprocessEnv,
                input: options.input,
                node: {
                  recorder: nodeProcessRecorder,
                  endTreeOnTimeout: options.endTreeOnTimeout === true,
                  abortSignal: options.abortSignal,
                },
              })
            : await execFileAsync(cmd, args, {
                cwd: options.cwd,
                timeout: options.timeout,
                env: subprocessEnv,
                input: options.input,
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

/**
 * Node mode keeps execFile's background-job and deadline semantics, while making
 * recorded trees endable. Stdin payload delivery is separate from the owner-death watcher.
 */
interface NodeProcessOptions {
  recorder: NodeProcessRecorder | undefined;
  endTreeOnTimeout: boolean;
  abortSignal?: AbortSignal;
}

/** Exported for tests, which mock it where a Windows bash or script node runs through it. */
export async function execOwnedProcessGroup(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    timeout?: number;
    env: NodeJS.ProcessEnv;
  } & ({ node?: NodeProcessOptions; input?: never } | { node: NodeProcessOptions; input?: string })
): Promise<{ stdout: string; stderr: string }> {
  const { node } = options;
  const recorder = node?.recorder;
  if (recorder?.ended) throw new Error('The run owner is terminating; node subprocess not started');
  const posix = process.platform !== 'win32';
  const lifeline = posix && !node;
  const child = spawn(cmd, lifeline ? ['-c', SETUP_LIFELINE, 'archon-setup', cmd, ...args] : args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: posix,
    stdio: [lifeline || node ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const maxBuffer = 1024 * 1024;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let failure: RawSubprocessRejection | undefined;
  let inputError: Error | undefined;
  let timedOut = false;
  let cancelled = false;
  let exited = false;
  let termination: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const endTree = (pid: number, signal: NodeJS.Signals): void => {
    termination = terminateTree(pid, signal).catch((error: unknown) => {
      terminationError = error instanceof Error ? error : new Error(String(error));
      // `close` waits for the root, so a root left running would hang the caller. SIGKILL,
      // because a root that ignores SIGTERM would otherwise outlive the deadline.
      if (!exited) child.kill('SIGKILL');
    });
  };
  const stop = (whole: boolean): void => {
    // Never signal a group after its leader exited: that PID may already be reused.
    if (termination || exited || child.pid === undefined) return;
    if (!whole) {
      child.kill('SIGTERM');
      return;
    }
    endTree(child.pid, node ? 'SIGTERM' : 'SIGKILL');
  };
  const rootPid = child.pid;
  recordNodeProcess(child, recorder, error => {
    error.message = `could not start the node's owner-death watcher: ${error.message}`;
    failure ??= error;
    stop(false);
  });
  const timer =
    options.timeout === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          stop(!node || node.endTreeOnTimeout);
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, options.timeout);
  const abortSignal = recorder ? node?.abortSignal : undefined;
  const abort = (): void => {
    cancelled = true;
    clearTimeout(timer);
    // Unlike `stop`, a POSIX abort still signals a group whose root exited: until `close`,
    // a background job can hold that group, and its PID stays reserved while the group
    // lives. Windows reserves no PID once the root exits, so taskkill could end a reused one.
    if (!termination && rootPid !== undefined && (posix || !exited)) endTree(rootPid, 'SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  if (abortSignal?.aborted) abort();
  else abortSignal?.addEventListener('abort', abort, { once: true });
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
      stop(!node);
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
  if (options.input !== undefined) {
    child.stdin?.on('error', error => {
      inputError = error;
    });
    child.stdin?.end(options.input, 'utf8');
  }
  const closed = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  abortSignal?.removeEventListener('abort', abort);
  child.stdin?.destroy();
  await termination;
  if (lifeline && child.pid !== undefined) {
    try {
      await confirmGroupGone(child.pid);
    } catch (error) {
      terminationError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (terminationError) {
    failure ??= new Error(
      cancelled
        ? 'Command cancelled'
        : node
          ? `Command timed out after ${options.timeout} ms`
          : 'Setup process group termination failed'
    );
    failure.message += `; could not terminate subprocess tree: ${terminationError.message}`;
  }
  // taskkill ends the root with exit code 1; a node deadline keeps the SIGTERM that
  // child.kill reported for it, as documented for `exit_code`.
  const exit = node && termination && !posix ? { code: null, signal: 'SIGTERM' } : closed;
  const output = { stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  if (timedOut || cancelled || failure || exit.code !== 0) {
    throw Object.assign(
      failure ??
        new Error(
          timedOut
            ? `Command timed out after ${options.timeout} ms`
            : cancelled
              ? 'Command cancelled'
              : `Command failed: ${cmd} ${args.join(' ')}\n${output.stderr}`
        ),
      {
        ...output,
        ...(!failure ? { code: exit.code } : {}),
        signal: exit.signal,
        timedOut,
        ...(node && terminationError ? { treeSurvived: true as const } : {}),
        ...(cancelled ? { cancelled: true as const } : {}),
        cmd: `${cmd} ${args.join(' ')}`,
        spawnargs: args,
      }
    );
  }
  if (inputError) throw Object.assign(inputError, output);
  return output;
}
