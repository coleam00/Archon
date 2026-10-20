import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  confirmProcessGroupsGone,
  inspectProcessGroups,
  terminateWindowsTree,
} from './plugin-process';

describe('inspectProcessGroups', () => {
  test('selects matching numeric groups', async () => {
    expect(await inspectProcessGroups([12], async () => ' 12\n 120\n 12\n')).toEqual([12, 12]);
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
    await expect(inspectProcessGroups([12], async () => '99999999999999999')).rejects.toThrow(
      'Invalid POSIX process identifier'
    );
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
        expect(members).toContain(child.pid);
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
