import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  confirmProcessGroupsGone,
  inspectProcessGroups,
  terminateWindowsTree,
} from './plugin-process';

describe('inspectProcessGroups', () => {
  test('selects numeric groups and preserves executable commands with spaces', async () => {
    expect(
      await inspectProcessGroups(
        [12],
        async () => ' 123 12 S /path with spaces/worker\n 124 120 S other\n 125 12 Z zombie\n'
      )
    ).toEqual([
      { pid: 123, pgid: 12, state: 'S', command: '/path with spaces/worker' },
      { pid: 125, pgid: 12, state: 'Z', command: 'zombie' },
    ]);
  });

  test('distinguishes no members from failed or malformed inspection', async () => {
    expect(await inspectProcessGroups([12], async () => '')).toEqual([]);
    await expect(
      inspectProcessGroups([12], async () => {
        throw new Error('ps refused');
      })
    ).rejects.toThrow('ps refused');
    await expect(inspectProcessGroups([12], async () => 'invalid listing')).rejects.toThrow(
      'Invalid POSIX process listing'
    );
    await expect(
      inspectProcessGroups([12], async () => '99999999999999999 12 S x')
    ).rejects.toThrow('Invalid POSIX process identifier');
  });

  test.skipIf(process.platform === 'win32')(
    'inspects a real group and confirms its disappearance',
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      });
      if (child.pid === undefined) throw new Error('Fixture failed to spawn');
      const exited = once(child, 'exit');
      try {
        const members = await inspectProcessGroups([child.pid]);
        expect(members).toContainEqual(
          expect.objectContaining({ pid: child.pid, pgid: child.pid })
        );
        await expect(confirmProcessGroupsGone([child.pid], 0)).rejects.toThrow('still running');
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
      await confirmProcessGroupsGone([child.pid], 1000);
    }
  );
});

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
