import { spawn } from 'node:child_process';
import { forceTerminateWindowsTree } from '@archon/paths/plugin-process';
import {
  confirmGroupGone,
  currentNodeProcessRecorder,
  ProcessGroupStillRunningError,
  TERMINATION_CONFIRM_MS,
} from './node-process-trees';

export const hostNodeSubprocess = { exec: execNodeBody };

export type ExitEvidence = { code: number | null; signal: string | null };

async function execNodeBody(
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  const recorder = currentNodeProcessRecorder();
  if (recorder?.ended) throw new Error('The run owner is terminating; node subprocess not started');
  const posix = process.platform !== 'win32';
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    detached: posix,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let observedExit: ExitEvidence | undefined;
  let failure: Error | undefined;
  let cleanupError: Error | undefined;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let stopped!: () => void;
  const stopCompleted = new Promise<void>(resolve => {
    stopped = resolve;
  });
  const terminate = async (): Promise<void> => {
    if (pid === undefined) return;
    if (!posix) {
      if (observedExit)
        throw new Error(`Process ${pid} exited before tree termination could be proved`);
      await forceTerminateWindowsTree(pid);
      const deadline = Date.now() + TERMINATION_CONFIRM_MS;
      while (!observedExit) {
        if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit after taskkill`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return;
    }
    const signal = (value: NodeJS.Signals): void => {
      if (observedExit) return;
      try {
        process.kill(-pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    signal('SIGTERM');
    try {
      await confirmGroupGone(pid, 5000);
    } catch (error) {
      // Once the leader exits we can probe its group, but must never signal it again.
      if (observedExit || !(error instanceof ProcessGroupStillRunningError)) throw error;
      signal('SIGKILL');
      await confirmGroupGone(pid);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): Promise<void> => {
    clearTimeout(timer);
    termination ??= terminate()
      .catch((error: unknown) => {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(stopped);
    return termination;
  };
  const closed = new Promise<void>(resolve => {
    child.once('error', error => {
      failure = error;
    });
    child.once('exit', (code, signal) => {
      observedExit = { code, signal };
      child.stdin?.destroy();
    });
    child.once('close', resolve);
  });
  if (pid !== undefined) {
    recorder?.roots.set(pid, {
      end: async () => {
        await stop();
        if (cleanupError) throw cleanupError;
      },
      disarm: () => undefined,
    });
  }
  timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, options.timeout);
  const maxBuffer = 1024 * 1024;
  const streams = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  for (const name of ['stdout', 'stderr'] as const) {
    child[name]?.on('data', (chunk: Buffer) => {
      const previous = streams[name];
      streams[name] = Buffer.concat([previous, chunk.subarray(0, maxBuffer - previous.length)]);
      if (previous.length + chunk.length > maxBuffer && !failure) {
        failure = Object.assign(new Error(`${name} maxBuffer length exceeded`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
        void stop();
      }
    });
  }
  await Promise.race([closed, stopCompleted]);
  clearTimeout(timer);
  await termination;
  if (pid !== undefined) recorder?.roots.delete(pid);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (cleanupError) child.unref();
  const output = {
    stdout: streams.stdout.toString('utf8'),
    stderr: streams.stderr.toString('utf8'),
  };
  if (timedOut || failure || cleanupError || observedExit?.code !== 0) {
    throw Object.assign(
      failure ??
        new Error(
          cleanupError
            ? `Could not terminate subprocess tree: ${cleanupError.message}`
            : timedOut
              ? `Command timed out after ${options.timeout} ms`
              : `Command failed: ${cmd} ${args.join(' ')}\n${output.stderr}`
        ),
      {
        ...output,
        ...(!failure ? { code: timedOut ? null : observedExit?.code } : {}),
        signal: timedOut ? 'SIGTERM' : observedExit?.signal,
        killed: timedOut,
        timedOut,
        observedExit,
        cleanupError,
        cmd: `${cmd} ${args.join(' ')}`,
        spawnargs: args,
      }
    );
  }
  return output;
}
