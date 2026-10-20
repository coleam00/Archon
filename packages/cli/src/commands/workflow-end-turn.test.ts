import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import * as stdout from '../utils/stdout';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

import { workflowEndTurnCommand } from './workflow-end-turn';

const RUN_ID = '8b465df4-ec97-4d6a-9d59-26b0e74d6a6c';

const stalledCall = {
  streamId: 'stream-1',
  nodeId: 'ci',
  provider: 'codex',
  toolCallId: 'subtask:command:thread:exec-1',
  name: 'command_execution',
  startedAt: '2026-10-18T06:25:58.000Z',
  lastProgressAt: '2026-10-18T06:25:58.000Z',
  raisedAt: '2026-10-18T06:55:59.000Z',
  thresholdMs: 1_800_000,
};

function hostWith(run: Partial<WorkflowRun> | null) {
  const updateWorkflowRun = mock(async () => undefined);
  const getWorkflowRun = mock(async () => (run ? ({ id: RUN_ID, ...run } as WorkflowRun) : null));
  const findWorkflowRunsByIdPrefix = mock(async () => [{ id: RUN_ID }]);
  const host = {
    records: { codebases: { findCodebaseByDefaultCwd: async () => ({ id: 'project' }) } },
    deps: {
      store: {
        getWorkflowRun,
        findWorkflowRunsByIdPrefix,
        updateWorkflowRun,
      },
    },
  } as unknown as WorkflowHost;
  return { host, updateWorkflowRun, getWorkflowRun, findWorkflowRunsByIdPrefix };
}

describe('workflow end-turn', () => {
  afterEach(() => {
    mock.restore();
  });

  it('records a request for the stalled stream', async () => {
    const output = spyOn(console, 'log').mockImplementation(() => {});
    const { host, updateWorkflowRun } = hostWith({
      status: 'running',
      metadata: { tool_call_attention: [stalledCall] },
    });
    expect(await workflowEndTurnCommand(host, RUN_ID)).toBe(0);
    expect(output.mock.calls[0]?.[0]).toContain('Recorded an end-turn request');
    expect(output.mock.calls[0]?.[0]).toContain('owner_lost');
    expect(updateWorkflowRun).toHaveBeenCalledWith(RUN_ID, {
      metadata: {
        end_turn_request: {
          stalls: { 'stream-1': stalledCall.raisedAt },
        },
      },
    });
  });

  it.each(['resolution', 'lookup', 'update'] as const)(
    'keeps the end-turn envelope when %s throws in JSON mode',
    async failure => {
      const output = spyOn(stdout, 'writeJsonLine').mockResolvedValue(undefined);
      const h = hostWith({ status: 'running', metadata: { tool_call_attention: [stalledCall] } });
      const input = failure === 'resolution' ? RUN_ID.slice(0, 8) : RUN_ID;
      if (failure === 'resolution') {
        h.findWorkflowRunsByIdPrefix.mockResolvedValue([{ id: RUN_ID }, { id: 'other-run' }]);
      } else if (failure === 'lookup') {
        h.getWorkflowRun.mockRejectedValue(new Error('lookup failed'));
      } else {
        h.updateWorkflowRun.mockRejectedValue(new Error('update failed'));
      }
      expect(await workflowEndTurnCommand(h.host, input, true, process.cwd())).toBe(1);
      expect(output).toHaveBeenCalledTimes(1);
      expect(output.mock.calls[0]?.[0]).toEqual({
        ok: false,
        runId: input,
        action: 'end_turn',
        error:
          failure === 'resolution'
            ? expect.stringContaining('matches more than one run')
            : `${failure} failed`,
      });
      if (failure !== 'update') expect(h.updateWorkflowRun).not.toHaveBeenCalled();
    }
  );

  it('keeps the resolved id when an update after prefix resolution throws', async () => {
    const output = spyOn(stdout, 'writeJsonLine').mockResolvedValue(undefined);
    const h = hostWith({ status: 'running', metadata: { tool_call_attention: [stalledCall] } });
    h.updateWorkflowRun.mockRejectedValue(new Error('update failed'));
    expect(await workflowEndTurnCommand(h.host, RUN_ID.slice(0, 8), true, process.cwd())).toBe(1);
    expect(output).toHaveBeenCalledWith({
      ok: false,
      runId: RUN_ID,
      action: 'end_turn',
      error: 'update failed',
    });
  });

  it('preserves thrown errors outside JSON mode', async () => {
    const output = spyOn(stdout, 'writeJsonLine').mockResolvedValue(undefined);
    const h = hostWith({ status: 'running' });
    const error = new Error('lookup failed');
    h.getWorkflowRun.mockRejectedValue(error);
    await expect(workflowEndTurnCommand(h.host, RUN_ID)).rejects.toBe(error);
    expect(output).not.toHaveBeenCalled();
  });

  it.each([
    ['a run with nothing stalled', { status: 'running' as const, metadata: {} }],
    ['a terminal run', { status: 'completed' as const, metadata: {} }],
    [
      'unreadable attention',
      { status: 'running' as const, metadata: { tool_call_attention: null } },
    ],
    ['an unknown run', null],
  ])('refuses %s without writing', async (_label, run) => {
    spyOn(console, 'error').mockImplementation(() => {});
    const { host, updateWorkflowRun } = hostWith(run);
    expect(await workflowEndTurnCommand(host, RUN_ID)).toBe(1);
    expect(updateWorkflowRun).not.toHaveBeenCalled();
  });
});
