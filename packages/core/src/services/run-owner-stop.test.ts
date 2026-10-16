// @archon-test-isolated
import { describe, expect, it, spyOn } from 'bun:test';
import {
  terminateWindowsProcessTree,
  windowsProcessCommands,
} from '@archon/paths/windows-process-tree';
import { startRunLiveOwner } from './run-live-owner';
import * as liveOwner from './run-live-owner';
import { DetachedRunOwnerUnavailableError, requestDetachedRunStop } from './run-owner-stop';

async function rejectionFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the command to reject');
}

describe('detached run control', () => {
  it('refuses owner termination and forwards node cleanup evidence to the stop caller', async () => {
    const runId = `cleanup-failure-${crypto.randomUUID()}`;
    const log = spyOn(console, 'error').mockImplementation(() => {});
    const signal = spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('Must not signal an owner after failed preparation');
    });
    const commands = spyOn(windowsProcessCommands, 'execFile').mockImplementation(async command => {
      if (command === 'taskkill') {
        throw new Error('taskkill denied; ' + 'Access denied\n'.repeat(100));
      }
      return {
        stdout: JSON.stringify({
          takenAt: '100',
          rows: [
            { pid: 10, parentPid: 1, created: '10' },
            { pid: 12, parentPid: 11, created: '50' },
          ],
        }),
        stderr: '',
      };
    });
    const owner = await startRunLiveOwner(runId, {
      detachedProcessPid: process.pid,
      beforeTerminate: () => terminateWindowsProcessTree(10, () => {}),
    });
    try {
      const target = await requestDetachedRunStop(runId);
      const error = await rejectionFrom(() => target.stop());
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected cleanup to fail');
      expect(error.message).toContain('taskkill denied');
      expect(error.message).toContain('processes 12 have unproved ancestry');
      expect(signal).not.toHaveBeenCalled();
    } finally {
      await owner.close();
      commands.mockRestore();
      signal.mockRestore();
      log.mockRestore();
    }
  });

  it.each([3, 8])(
    'retains per-tree evidence for %i cleanup failures through the lease',
    async count => {
      const log = spyOn(console, 'error').mockImplementation(() => {});
      const previous = process.env.ARCHON_TEST_TREE_TOKEN;
      process.env.ARCHON_TEST_TREE_TOKEN = 'private-tree-credential';
      const runId = `multi-cleanup-${crypto.randomUUID()}`;
      const failures = Array.from(
        { length: count },
        (_, index) =>
          new Error(
            `${(index + 1) * 10} (taskkill denied private-tree-credential; ${'x'.repeat(700)}; ancestry unproved for ${(index + 1) * 10})`
          )
      );
      const owner = await startRunLiveOwner(runId, {
        detachedProcessPid: process.pid,
        beforeTerminate: async () => {
          throw new AggregateError(
            failures,
            `could not end node process trees: ${failures.map(error => error.message).join(', ')}`
          );
        },
      });
      try {
        const target = await requestDetachedRunStop(runId);
        const error = await rejectionFrom(() => target.stop());
        if (!(error instanceof Error)) throw new Error('Expected cleanup to fail');
        for (let index = 0; index < Math.min(count, 4); index++) {
          expect(error.message).toContain(`${(index + 1) * 10} (taskkill denied [REDACTED]`);
          expect(error.message).toContain(`ancestry unproved for ${(index + 1) * 10})`);
        }
        if (count > 4)
          expect(error.message).toContain('4 additional failures omitted; see owner log');
        expect(error.message.length).toBeLessThan(1100);
        expect(error.message).not.toContain('private-tree-credential');
        const records = log.mock.calls.map(call => call.join(' '));
        for (let index = 0; index < count; index++) {
          expect(
            records.some(
              record =>
                record.includes(`${(index + 1) * 10} (taskkill denied [REDACTED]`) &&
                record.includes(`ancestry unproved for ${(index + 1) * 10})`)
            )
          ).toBe(true);
        }
        expect(
          records.every(
            record => record.length < 1100 && !record.includes('private-tree-credential')
          )
        ).toBe(true);
      } finally {
        await owner.close();
        log.mockRestore();
        if (previous === undefined) delete process.env.ARCHON_TEST_TREE_TOKEN;
        else process.env.ARCHON_TEST_TREE_TOKEN = previous;
      }
    }
  );

  it('fails explicitly when no live owner is reachable', async () => {
    const runId = `missing-${crypto.randomUUID()}`;
    const error = await rejectionFrom(() => requestDetachedRunStop(runId));
    expect(error).toBeInstanceOf(DetachedRunOwnerUnavailableError);
  });
});

it
  .skipIf(process.platform === 'win32')
  .each(['lease lost', 'leader exited', 'owned leader'] as const)(
  'checks owner identity before escalation: %s',
  async state => {
    const pid = 424242;
    let terminated = false;
    let killed = false;
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const lease = spyOn(liveOwner, 'requestRunLiveOwnerStop').mockResolvedValue({
      pid,
      commit: async () => {},
      release: () => {},
      isLive: () => !terminated || state !== 'lease lost',
    });
    const signal = spyOn(process, 'kill').mockImplementation((target, value) => {
      if (target === -pid && value === 'SIGTERM') terminated = true;
      else if (target === -pid && value === 'SIGKILL') killed = true;
      else if (target === -pid && value === 0) {
        if (killed) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        now += 6000;
      } else if (target === pid && value === 0) {
        if (state === 'leader exited') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      } else throw new Error('Unexpected process signal');
      return true;
    });
    try {
      const target = await requestDetachedRunStop('escalation');
      if (state === 'owned leader') {
        await target.stop();
        expect(killed).toBe(true);
      } else {
        await expect(target.stop()).rejects.toThrow('before escalation');
        expect(killed).toBe(false);
      }
    } finally {
      signal.mockRestore();
      lease.mockRestore();
      clock.mockRestore();
    }
  }
);
