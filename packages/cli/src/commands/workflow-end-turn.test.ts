import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
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
  const host = {
    deps: {
      store: {
        getWorkflowRun: async () => (run ? ({ id: RUN_ID, ...run } as WorkflowRun) : null),
        updateWorkflowRun,
      },
    },
  } as unknown as WorkflowHost;
  return { host, updateWorkflowRun };
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
          requestedAt: expect.any(String),
        },
      },
    });
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
