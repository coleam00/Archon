import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { inspectChat, type ChatPluginDescriptor } from '@archon/chat-contract';
import { terminateTree, validateCommand } from '@archon/paths/plugin-process';

export async function inspectChatPlugin(executable: string): Promise<ChatPluginDescriptor> {
  const failure = (): Error => new Error(`Chat plugin ${executable} failed initialize`);
  if (validateCommand(executable)) throw failure();
  let child;
  try {
    child = spawn(executable, [], {
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    throw failure();
  }
  const pid = child.pid;
  let exited = false;
  const closed = new Promise<void>(resolve => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
  });
  let rejectProcess: (error: Error) => void = () => undefined;
  const processFailure = new Promise<never>((_, reject) => {
    rejectProcess = reject;
  });
  child.on('error', () => {
    rejectProcess(failure());
  });
  child.stdin.on('error', () => {
    rejectProcess(failure());
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = async (): Promise<void> => {
    try {
      if (pid !== undefined && (!exited || process.platform !== 'win32')) await terminateTree(pid);
    } catch {
      throw new Error(`Chat plugin ${executable}: process cleanup failed (pid ${String(pid)})`);
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
    }
    await closed;
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(failure());
      }, 10_000);
    });
    return await Promise.race([
      inspectChat({
        readable: Readable.toWeb(child.stdout),
        writable: Writable.toWeb(child.stdin),
      }),
      processFailure,
      timeout,
    ]);
  } catch {
    // Remote errors and transport diagnostics can contain credentials or user messages.
    throw failure();
  } finally {
    clearTimeout(timer);
    await cleanup();
  }
}
