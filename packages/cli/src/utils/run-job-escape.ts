import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { parseArgs } from 'util';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { cliArgOptions } from '../args';
import { cliProgramArguments } from './cli-program-arguments';
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
 * Only the CLI's own `--detach` launches go through the broker. Any other process in the
 * run that asks Windows for breakaway is still refused by the job.
 */

/** In a Windows run owner and its descendants: the pipe of the owner's broker. */
export const RUN_JOB_ESCAPE_ENV = 'ARCHON_RUN_JOB_ESCAPE';
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
    !Object.values(parsed.env).every(value => typeof value === 'string')
  ) {
    throw new Error('invalid invocation');
  }
  const argv = parsed.argv;
  const args = argv.slice(program.length);
  if (program.some((part, index) => argv[index] !== part) || !isDetachedLaunch(args)) {
    throw new Error("Only this CLI's workflow run --detach launches may leave the run job");
  }
  return parsed as EscapedInvocation;
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
  const [command, ...args] = invocation.argv;
  const child = spawn(command, args, {
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
  const broker = spawn(program[0], program.slice(1), {
    env: { ...process.env, [BROKER_ENV]: pipe },
    // The owner never writes to stdin; its end closing is how the broker learns the owner
    // is gone. `detached` keeps the broker out of the runtime's own kill-on-close job.
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
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
      argv: [...cliProgramArguments(), ...args],
      cwd: process.cwd(),
      env: inheritedEnv,
    })
  );
}

/** Whether `args` launch a detached run owner (`--detach`). */
export function isDetachedLaunch(args: readonly string[]): boolean {
  // Lenient: the strict parse in the relayed process reports a malformed command.
  const { values, positionals } = parseArgs({
    args: [...args],
    options: cliArgOptions,
    allowPositionals: true,
    strict: false,
  });
  return positionals[0] === 'workflow' && positionals[1] === 'run' && values.detach === true;
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
        `Could not run this --detach launch outside the run's Windows job object: ${detail}`
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
        result = frame;
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
