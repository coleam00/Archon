// @archon-test-isolated
import { describe, expect, it, spyOn } from 'bun:test';
import {
  terminateWindowsProcessTree,
  windowsProcessCommands,
} from '@archon/paths/windows-process-tree';
import { startRunLiveOwner } from './run-live-owner';
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

  it('fails explicitly when no live owner is reachable', async () => {
    const runId = `missing-${crypto.randomUUID()}`;
    const error = await rejectionFrom(() => requestDetachedRunStop(runId));
    expect(error).toBeInstanceOf(DetachedRunOwnerUnavailableError);
  });
});
