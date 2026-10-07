import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { terminateTree, validateCommand } from '@archon/paths/plugin-process';
import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import { connectProvider, type ProviderPluginDescriptor } from '@archon/provider-contract/plugin';

export async function inspectProviderPlugin(executable: string): Promise<ProviderPluginDescriptor> {
  const invalid = validateCommand(executable);
  if (invalid) throw new Error(invalid);
  const child = spawn(executable, [], {
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: buildProviderSubprocessEnv({}),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pid = child.pid;
  let exited = false;
  const closed = new Promise<void>(resolve => {
    child.once('close', () => {
      exited = true;
      resolve();
    });
  });
  child.on('error', () => undefined);
  child.stdin.on('error', () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('initialize timed out'));
      }, 10_000);
    });
    const connection = await Promise.race([
      connectProvider({
        readable: Readable.toWeb(child.stdout),
        writable: Writable.toWeb(child.stdin),
      }),
      timeout,
    ]);
    return connection.descriptor;
  } catch {
    // Plugin-controlled errors can contain credentials or message excerpts.
    throw new Error(`Provider plugin ${executable} failed initialize; no provider was installed`);
  } finally {
    clearTimeout(timer);
    try {
      if (pid !== undefined && (!exited || process.platform !== 'win32')) await terminateTree(pid);
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      await closed;
    }
  }
}
