import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { parseArgs } from 'util';
import { BUNDLED_IS_BINARY, createLogger } from '@archon/paths';
import { cliArgOptions } from '../args';
import type { runDetachedControlCommand } from '../commands/workflow-detach';
import { withDrainedExit } from './exit-with-drain';
import { writeStderr, writeStdout } from './stdout';

/*
 * The way a detached launch made inside a Windows run leaves that run's job object.
 *
 * A detached owner's job holds every process the run starts and grants no breakaway
 * (`windows-run-job.ts` in core), so `workflow run --detach` from a node would put the new
 * run's owner in the launching run's job, and cancelling the launching run would kill a
 * run it does not own. So before the owner joins its job, it starts a broker, which stays
 * outside the job, and names the broker's pipe in the environment its descendants inherit.
 * A `--detach` command that finds the pipe sends its whole invocation there instead of
 * running it. The broker runs it outside the job and relays its output and exit status, so
 * the detached owner it launches starts outside the launching run's job and claims its own.
 *
 * A trigger executor (`trigger execute`) is the other detached owner a run starts: the
 * owner starts one for each follow-up its end admits, and a node can fire a trigger. The
 * job is kill-on-close, so an executor started inside it would die when its launcher's
 * owner exits. {@link startTriggerExecutor} hands it to the broker, which starts it
 * detached outside the job and answers once it has started.
 *
 * Only these two launches go through the broker. Any other process in the run that asks
 * Windows for breakaway is still refused by the job.
 */

/** In a Windows run owner and its descendants: the pipe of the owner's broker. */
export const RUN_JOB_ESCAPE_ENV = 'ARCHON_RUN_JOB_ESCAPE';
export const RUN_JOB_ESCAPE_BUN_CONFIG_ARG = `--config=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`;
/** In the broker process only: the pipe it serves. */
const BROKER_ENV = 'ARCHON_RUN_JOB_ESCAPE_BROKER';
const BROKER_READY = 'ready\n';
const BROKER_STARTUP_TIMEOUT_MS = 10_000;

function brokerProgram(): [string, ...string[]] {
  return BUNDLED_IS_BINARY
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, '..', 'cli.ts')];
}

/** One CLI invocation for the broker to run outside the job. */
export interface EscapedInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * For a trigger executor only: the log its output appends to. The broker starts it
   * detached and answers once it has started, rather than relaying its output and exit.
   */
  readonly log?: string;
}

type BrokerFrame =
  | { readonly stream: 'stdout' | 'stderr'; readonly data: string }
  | { readonly exit: number }
  | { readonly error: string };

/** Call each complete newline-terminated line `socket` receives. */
function onLines(socket: Socket, onLine: (line: string) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let end = buffered.indexOf('\n');
    while (end !== -1) {
      onLine(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf('\n');
    }
  });
}

function sendFrame(socket: Socket, frame: BrokerFrame): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function parseInvocation(line: string, program: readonly [string, ...string[]]): EscapedInvocation {
  const parsed: unknown = JSON.parse(line);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('argv' in parsed) ||
    !Array.isArray(parsed.argv) ||
    parsed.argv.length === 0 ||
    !parsed.argv.every(arg => typeof arg === 'string') ||
    !('cwd' in parsed) ||
    typeof parsed.cwd !== 'string' ||
    !('env' in parsed) ||
    typeof parsed.env !== 'object' ||
    parsed.env === null ||
    !Object.values(parsed.env).every(value => typeof value === 'string') ||
    ('log' in parsed && typeof parsed.log !== 'string')
  ) {
    throw new Error('invalid invocation');
  }
  const argv = parsed.argv;
  const args = argv.slice(program.length);
  const executor = 'log' in parsed;
  if (
    program.some((part, index) => argv[index] !== part) ||
    !(executor ? isTriggerExecutor(args) : isDetachedLaunch(args))
  ) {
    throw new Error("Only this CLI's detached workflow launches may leave the run job");
  }
  return parsed as EscapedInvocation;
}

/** Whether `args` are exactly `trigger execute <request-id> --host <host-id>`. */
export function isTriggerExecutor(args: readonly string[]): boolean {
  return (
    args.length === 5 &&
    args[0] === 'trigger' &&
    args[1] === 'execute' &&
    args[3] === '--host' &&
    [args[2], args[4]].every(value => value !== undefined && value !== '' && !value.startsWith('-'))
  );
}

/**
 * Start a detached trigger executor appending its output to `log`, and resolve with its pid
 * once it has started. It does not wait for the executor, which runs a whole workflow. It
 * rejects only before the executor starts.
 */
async function spawnTriggerExecutor(
  [command, ...args]: readonly [string, ...string[]],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  log: string
): Promise<number> {
  const file = await open(log, 'a', 0o600);
  let pid: number;
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', file.fd, file.fd],
      windowsHide: true,
      env,
    });
    // Node sets `pid` before `spawn` fires, so a missing pid means nothing started.
    pid = await new Promise<number>((resolveSpawn, reject) => {
      child.once('error', reject);
      child.once('spawn', () =>
        child.pid === undefined
          ? reject(new Error('The spawned executor reported no process id.'))
          : resolveSpawn(child.pid)
      );
    });
    child.unref();
  } catch (error) {
    await file.close();
    throw error;
  }
  // The executor holds its own copy of the log descriptor; closing ours cannot undo the start.
  await file.close().catch((error: unknown) => {
    createLogger('cli.run-job-escape').warn(
      { err: error as Error },
      'trigger_executor.log_close_failed'
    );
  });
  return pid;
}

/**
 * Relaying a trigger executor through the run's broker failed. The broker may have started
 * it before the failure, so whether it runs is unknown.
 */
export class TriggerExecutorRelayError extends Error {
  constructor(options: ErrorOptions) {
    super('The run job broker did not confirm the trigger executor', options);
    this.name = 'TriggerExecutorRelayError';
  }
}

/** A trigger executor to start: its CLI arguments, where it runs, and its log. */
export interface TriggerExecutorLaunch {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: string;
}

/**
 * Start a detached trigger executor. Inside a Windows run it starts through that run's
 * broker, so it is outside the run's job and outlives the run; elsewhere it starts here.
 * Resolves with the executor's pid when it started here, and with undefined when the broker
 * started it, since the broker does not report it. A failed relay rejects with
 * {@link TriggerExecutorRelayError}.
 */
export async function startTriggerExecutor(
  launch: TriggerExecutorLaunch,
  localProgram: readonly [string, ...string[]]
): Promise<number | undefined> {
  const pipe = process.env[RUN_JOB_ESCAPE_ENV];
  if (pipe === undefined)
    return spawnTriggerExecutor(
      [...localProgram, ...launch.args],
      launch.cwd,
      launch.env,
      launch.log
    );
  const discard = async (): Promise<void> => undefined;
  let code: number;
  try {
    code = await relayOutsideRunJob(
      pipe,
      {
        argv: [...brokerProgram(), ...launch.args],
        cwd: launch.cwd,
        env: launch.env,
        log: launch.log,
      },
      { stdout: discard, stderr: discard }
    );
  } catch (error) {
    throw new TriggerExecutorRelayError({ cause: error });
  }
  if (code !== 0)
    throw new Error(`The run job broker could not start the trigger executor (${String(code)})`);
  return undefined;
}

/** Run one relayed invocation and stream its output and exit status back. */
function runInvocation(
  socket: Socket,
  line: string,
  program: readonly [string, ...string[]]
): void {
  let invocation: EscapedInvocation;
  try {
    invocation = parseInvocation(line, program);
  } catch (error) {
    sendFrame(socket, { error: (error as Error).message });
    socket.end();
    return;
  }
  // The relayed command must run, not relay again to this broker.
  const env = { ...invocation.env };
  Reflect.deleteProperty(env, RUN_JOB_ESCAPE_ENV);
  // Bun startup hooks run before the CLI can give the detached run its own owner.
  env.BUN_OPTIONS = '';
  const [command, ...args] = invocation.argv;
  // Release binaries disable bunfig autoload at build time; source Bun needs it here.
  const argv: [string, ...string[]] = [
    command,
    ...(BUNDLED_IS_BINARY ? args : [RUN_JOB_ESCAPE_BUN_CONFIG_ARG, ...args]),
  ];
  if (invocation.log !== undefined) {
    spawnTriggerExecutor(argv, invocation.cwd, env, invocation.log).then(
      () => {
        sendFrame(socket, { exit: 0 });
        socket.end();
      },
      (error: unknown) => {
        sendFrame(socket, { error: error instanceof Error ? error.message : String(error) });
        socket.end();
      }
    );
    return;
  }
  const child = spawn(argv[0], argv.slice(1), {
    cwd: invocation.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk: Buffer) => {
    sendFrame(socket, { stream: 'stdout', data: chunk.toString('base64') });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    sendFrame(socket, { stream: 'stderr', data: chunk.toString('base64') });
  });
  // `close` fires after both pipes drained, so every output frame precedes the exit frame.
  // A process that could not start reports `error` and may still report `close`.
  child.once('error', error => {
    if (socket.writableEnded) return;
    sendFrame(socket, { error: error.message });
    socket.end();
  });
  child.once('close', code => {
    if (socket.writableEnded) return;
    sendFrame(socket, { exit: code ?? 1 });
    socket.end();
  });
}

export interface RunJobEscapeServer {
  /** Stop accepting invocations and resolve once every accepted one has finished. */
  close(): Promise<void>;
}

/** Serve one broker connection: run the first invocation it sends. */
export function acceptRelayConnection(
  socket: Socket,
  program: readonly [string, ...string[]] = brokerProgram()
): void {
  // A launcher killed mid-invocation breaks only its own connection. Unhandled, the error
  // would end the broker and every later --detach launch of the run. The relayed command
  // keeps running: it may already have started a detached owner.
  socket.on('error', () => {
    socket.destroy();
  });
  let received = false;
  onLines(socket, line => {
    if (received) return;
    received = true;
    runInvocation(socket, line, program);
  });
}

/** Serve relayed invocations on `pipe`. */
export async function serveRunJobEscape(
  pipe: string,
  program: readonly [string, ...string[]] = brokerProgram()
): Promise<RunJobEscapeServer> {
  const server = createServer(socket => acceptRelayConnection(socket, program));
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(pipe, resolveListen);
  });
  return {
    close: () =>
      new Promise<void>(resolveClose => {
        server.close(() => {
          resolveClose();
        });
      }),
  };
}

/**
 * Start the broker for this run owner and return its pipe. Call it before the owner joins
 * its job: the broker is outside the job only because it already exists when the owner
 * joins.
 */
export async function startRunJobEscapeBroker(): Promise<string> {
  const pipe = `\\\\.\\pipe\\archon-run-escape-${randomUUID()}`;
  const program = brokerProgram();
  const args = program.slice(1);
  const broker = spawn(
    program[0],
    BUNDLED_IS_BINARY ? args : [RUN_JOB_ESCAPE_BUN_CONFIG_ARG, ...args],
    {
      // The broker starts outside the job, so startup hooks cannot run here either.
      env: { ...process.env, BUN_OPTIONS: '', [BROKER_ENV]: pipe },
      // The owner never writes to stdin; its end closing is how the broker learns the owner
      // is gone. `detached` keeps the broker out of the runtime's own kill-on-close job.
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    }
  );
  await waitForRunJobEscapeBroker(broker);
  return pipe;
}

export async function waitForRunJobEscapeBroker(
  broker: ChildProcessByStdio<Writable, Readable, Readable>,
  timeoutMs = BROKER_STARTUP_TIMEOUT_MS
): Promise<void> {
  let stderr = '';
  const captureError = (chunk: Buffer): void => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  };
  broker.stderr.on('data', captureError);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClose: ((code: number | null) => void) | undefined;
  try {
    await new Promise<void>((resolveReady, reject) => {
      let output = '';
      timer = setTimeout(() => {
        reject(
          new Error(
            `Windows run job broker did not become ready within ${String(timeoutMs)} ms${stderr ? `: ${stderr}` : ''}`
          )
        );
      }, timeoutMs);
      broker.once('error', reject);
      onClose = code => {
        reject(
          new Error(
            `Windows run job broker exited during startup (code ${String(code)})${stderr ? `: ${stderr}` : ''}`
          )
        );
      };
      broker.once('close', onClose);
      broker.stdout.setEncoding('utf8');
      broker.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes(BROKER_READY)) resolveReady();
      });
    });
  } catch (error) {
    broker.kill();
    throw error;
  } finally {
    clearTimeout(timer);
    if (onClose !== undefined) broker.removeListener('close', onClose);
    broker.stdout.destroy();
    broker.stderr.destroy();
  }
}

/** The broker's process body: serve until the owner that started it exits. */
async function serveUntilOwnerExits(pipe: string): Promise<number> {
  const server = await serveRunJobEscape(pipe);
  await writeStdout(BROKER_READY);
  await new Promise<void>(resolveEnd => {
    process.stdin.once('end', resolveEnd);
    process.stdin.once('close', resolveEnd);
    process.stdin.resume();
  });
  // Finishes the invocations already accepted.
  await server.close();
  return 0;
}

/**
 * The CLI's entry into this escape, before `main`, so telemetry counts a relayed invocation
 * once, in the relayed process. A broker serves and a `--detach` launch inside a Windows run
 * relays; either exits the process here. Anything else returns and runs as usual.
 */
export async function escapeRunJobIfRequested(
  args: readonly string[],
  inheritedEnv: Readonly<Record<string, string | undefined>>
): Promise<void> {
  const brokerPipe = process.env[BROKER_ENV];
  if (brokerPipe !== undefined) await withDrainedExit(() => serveUntilOwnerExits(brokerPipe));
  const pipe = process.env[RUN_JOB_ESCAPE_ENV];
  if (pipe === undefined || !isDetachedLaunch(args)) return;
  await withDrainedExit(() =>
    relayOutsideRunJob(pipe, {
      argv: [...brokerProgram(), ...args],
      cwd: process.cwd(),
      env: inheritedEnv,
    })
  );
}

const detachedWorkflowActions = {
  run: true,
  resume: true,
  approve: true,
  reject: true,
  respond: true,
} satisfies Record<'run' | Parameters<typeof runDetachedControlCommand>[1], true>;

/** Whether `args` launch a detached run owner (`--detach`). */
export function isDetachedLaunch(args: readonly string[]): boolean {
  // Lenient: the strict parse in the relayed process reports a malformed command.
  const { values, positionals } = parseArgs({
    args: [...args],
    options: cliArgOptions,
    allowPositionals: true,
    strict: false,
  });
  return (
    positionals[0] === 'workflow' &&
    positionals[1] !== undefined &&
    Object.hasOwn(detachedWorkflowActions, positionals[1]) &&
    values.detach === true
  );
}

interface RelayOutput {
  stdout(data: Uint8Array): Promise<void>;
  stderr(data: Uint8Array): Promise<void>;
}

/** Run `invocation` through the broker at `pipe` and return its exit status. */
export async function relayOutsideRunJob(
  pipe: string,
  invocation: EscapedInvocation,
  output: RelayOutput = { stdout: writeStdout, stderr: writeStderr }
): Promise<number> {
  const socket = createConnection(pipe);
  let written = Promise.resolve();
  const exit = await new Promise<number>((resolveExit, reject) => {
    let result: { exit: number } | { error: string } | undefined;
    const unrelayed = (detail: string): Error =>
      new Error(
        `Could not run this detached launch outside the run's Windows job object: ${detail}`
      );
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(invocation)}\n`);
    });
    onLines(socket, line => {
      const frame = JSON.parse(line) as BrokerFrame;
      if ('stream' in frame) {
        const data = Buffer.from(frame.data, 'base64');
        written = written.then(() => output[frame.stream](data));
      } else {
        // The exit or error frame is the broker's last. Close here rather than wait for the
        // broker's end to arrive: on a Windows named pipe under Bun that took seconds.
        result = frame;
        socket.destroy();
      }
    });
    socket.once('error', error => {
      reject(unrelayed(error.message));
    });
    socket.once('close', () => {
      if (result === undefined) reject(unrelayed('the broker closed without an exit status'));
      else if ('error' in result) reject(unrelayed(result.error));
      else resolveExit(result.exit);
    });
  });
  await written;
  return exit;
}
