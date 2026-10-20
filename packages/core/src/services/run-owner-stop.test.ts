// @archon-test-isolated
import { describe, expect, it, mock, spyOn } from 'bun:test';
import * as processTools from '@archon/paths/plugin-process';
import * as liveOwner from './run-live-owner';
import {
  cancelWorkflow,
  makePausedRun,
  mockGetWorkflowRun,
  mockCancelWorkflowRun,
  mockRequestDetachedRunStop,
  operator,
  CancelRefusedError,
} from '../operations/workflow/test-harness';
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
  it('fails explicitly when no live owner is reachable', async () => {
    const runId = `missing-${crypto.randomUUID()}`;
    const error = await rejectionFrom(() => requestDetachedRunStop(runId));
    expect(error).toBeInstanceOf(DetachedRunOwnerUnavailableError);
  });
});

const posix = process.platform === 'win32' ? it.skip : it;
posix.each(['inspection failure', 'surviving group'] as const)(
  'prepared stop refuses %s without recording cancellation',
  async mode => {
    const ownerPid = 100000000;
    const nodePgid = ownerPid + 1;
    const release = mock(() => undefined);
    const lease = spyOn(liveOwner, 'requestRunLiveOwnerStop').mockResolvedValue({
      pid: ownerPid,
      windowsJob: undefined,
      commit: async () => ({
        groups: [{ pgid: nodePgid, leaderReaped: false }],
        warnings: [],
      }),
      isLive: () => true,
      release,
    });
    const signals = spyOn(process, 'kill').mockImplementation(() => true);
    const inspect = spyOn(processTools, 'inspectProcessGroups').mockImplementation(async groups => {
      expect(groups).toEqual([ownerPid, nodePgid]);
      if (mode === 'inspection failure') throw new Error('fixture ps failure');
      return [nodePgid];
    });
    mockGetWorkflowRun.mockResolvedValue(makePausedRun({ status: 'running' }));
    mockCancelWorkflowRun.mockClear();
    mockRequestDetachedRunStop.mockImplementation(requestDetachedRunStop);
    try {
      const error = await rejectionFrom(() => cancelWorkflow('run-1', operator));
      expect(error).toBeInstanceOf(CancelRefusedError);
      expect(error).toMatchObject({ reason: 'not_stopped' });
      expect((error as Error).message).toContain(
        mode === 'inspection failure' ? 'fixture ps failure' : 'Process groups still running'
      );
      expect(inspect).toHaveBeenCalled();
      expect(signals.mock.calls).toEqual([[-ownerPid, 'SIGKILL']]);
      expect(release).toHaveBeenCalledTimes(1);
      expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    } finally {
      lease.mockRestore();
      signals.mockRestore();
      inspect.mockRestore();
    }
  }
);
