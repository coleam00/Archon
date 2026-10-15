import { describe, expect, test } from 'bun:test';
import { terminateWindowsTree } from './plugin-process';

const taskkillExit = (code: number) => (): Promise<never> =>
  Promise.reject(Object.assign(new Error(`taskkill exited ${code}`), { code }));

describe('terminateWindowsTree', () => {
  test('resolves when taskkill exits 255 and the root is gone', async () => {
    const child = Bun.spawn([process.execPath, '-e', '']);
    await child.exited;
    await terminateWindowsTree(child.pid, taskkillExit(255));
  });

  test('rejects with the taskkill error when the root is still alive', async () => {
    await expect(terminateWindowsTree(process.pid, taskkillExit(255))).rejects.toThrow(
      'taskkill exited 255'
    );
  });
});

test.skipIf(process.platform !== 'win32')(
  'strict taskkill rejects even when the root has exited',
  async () => {
    const { forceTerminateWindowsTree } = await import('./plugin-process');
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e', '']);
    await child.exited;
    await expect(forceTerminateWindowsTree(child.pid)).rejects.toBeDefined();
  }
);
