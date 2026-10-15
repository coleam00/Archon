// @archon-test-isolated
import { describe, expect, it, spyOn } from 'bun:test';
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
    const owner = await startRunLiveOwner(runId, {
      detachedProcessPid: process.pid,
      beforeTerminate: async () => {
        throw new Error('taskkill denied; processes 12 have unproved ancestry');
      },
    });
    try {
      const target = await requestDetachedRunStop(runId);
      await expect(target.stop()).rejects.toThrow(
        'taskkill denied; processes 12 have unproved ancestry'
      );
      expect(signal).not.toHaveBeenCalled();
    } finally {
      await owner.close();
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
