import { describe, expect, test } from 'bun:test';
import { terminateWindowsTree } from './plugin-process';

const taskkillExit = (code: number) => (): Promise<never> =>
  Promise.reject(Object.assign(new Error(`taskkill exited ${code}`), { code }));

describe('terminateWindowsTree', () => {
  test('resolves when taskkill exits 255 and the root is gone', async () => {
    await terminateWindowsTree(3652, taskkillExit(255), () => true);
  });

  test('rejects with the taskkill error when the root is still alive', async () => {
    await expect(terminateWindowsTree(3652, taskkillExit(255), () => false)).rejects.toThrow(
      'taskkill exited 255'
    );
  });
});
