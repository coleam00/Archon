import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'util';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { cliArgOptions } from '../args';
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

function parseInvocation(line: string): EscapedInvocation {
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
  return parsed as EscapedInvocation;
}

/** Run one relayed invocation and stream its output and exit status back. */
function runInvocation(socket: Socket, line: string): void {
  let invocation: EscapedInvocation;
  try {
    invocation = parseInvocation(line);
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

/** Serve relayed invocations on `pipe`. */
export async function serveRunJobEscape(pipe: string): Promise<RunJobEscapeServer> {
  const server = createServer(socket => {
    let received = false;
    onLines(socket, line => {
      if (received) return;
      received = true;
      runInvocation(socket, line);
    });
  });
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
  const program = BUNDLED_IS_BINARY
    ? [process.execPath]
    : [process.execPath, resolve(import.meta.dir, '..', 'cli.ts')];
  const broker = spawn(program[0], program.slice(1), {
    env: { ...process.env, [BROKER_ENV]: pipe },
    // The owner never writes to stdin; its end closing is how the broker learns the owner
    // is gone. `detached` keeps the broker out of the runtime's own kill-on-close job.
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
    windowsHide: true,
  });
  await new Promise<void>((resolveReady, reject) => {
    let output = '';
    broker.once('error', reject);
    broker.once('exit', code => {
      reject(new Error(`Windows run job broker exited during startup (code ${String(code)})`));
    });
    broker.stdout.setEncoding('utf8');
    broker.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes(BROKER_READY)) resolveReady();
    });
  });
  broker.removeAllListeners('exit');
  broker.stdout.destroy();
  return pipe;
}

/**
 * The broker's process body, when this CLI process is a broker: serve until the owner that
 * started it exits, then finish the invocations already accepted.
 */
export async function runRunJobEscapeBrokerIfRequested(): Promise<boolean> {
  const pipe = process.env[BROKER_ENV];
  if (pipe === undefined) return false;
  const server = await serveRunJobEscape(pipe);
  await writeStdout(BROKER_READY);
  await new Promise<void>(resolveEnd => {
    process.stdin.once('end', resolveEnd);
    process.stdin.once('close', resolveEnd);
    process.stdin.resume();
  });
  await server.close();
  return true;
}

/** Whether `args` launch a detached run owner (`--detach`). */
export function isDetachedLaunch(args: readonly string[]): boolean {
  // Lenient: the strict parse in the relayed process reports a malformed command.
  const { values } = parseArgs({
    args: [...args],
    options: cliArgOptions,
    allowPositionals: true,
    strict: false,
  });
  return values.detach === true;
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
