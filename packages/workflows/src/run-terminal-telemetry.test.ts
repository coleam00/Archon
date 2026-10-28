// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { buildRunTerminalTelemetry, type RunTelemetryEvent } from './run-terminal-telemetry';
import { buildTerminalRecord, observeRunArtifacts } from './terminal-record';
import { WORKFLOW_TERMINAL_EVENT_TYPE } from '@archon/paths';
import { RUN_DISPATCH_METADATA_KEY, TERMINAL_RUN_EVENT_TYPE } from './schemas/workflow-run';
import { RUN_GRAPH_METADATA_KEY } from './schemas/terminal-record';

import { finishNodeExecution, newNodeInvocation, startNodeExecution } from './node-execution';
import { serializeNodeStateRecord } from './node-record-serialization';

const run = {
  id: 'run-1',
  workflow_name: 'implement',
  parent_run_id: null,
  status: 'failed' as const,
  metadata: { [RUN_GRAPH_METADATA_KEY]: { node_ids: ['plan', 'build'] } },
};
const noUsage = {};

async function failedRunEvents(): Promise<RunTelemetryEvent[]> {
  const events: RunTelemetryEvent[] = [
    {
      event_type: 'node_completed',
      step_name: 'plan',
      data: {},
      created_at: '2026-09-24 10:00:05',
    },
    {
      event_type: 'node_failed',
      step_name: 'build',
      data: { error: 'exit 1', failure_kind: 'exec_failed' },
      created_at: '2026-09-24 10:00:09',
    },
  ];
  const terminalRun = { ...run, outcome: null, output_root: null };
  const terminalRecord = buildTerminalRecord({
    run: terminalRun,
    events,
    artifacts: await observeRunArtifacts(terminalRun),
  });
  return [
    ...events,
    {
      event_type: 'workflow_failed',
      data: { error: 'failed', exit_reason: 'node_error', terminal_record: terminalRecord },
      created_at: '2026-09-24 10:00:10',
    },
  ];
}

describe('buildRunTerminalTelemetry', () => {
  test('reports nothing for a run that is not terminal', () => {
    expect(
      buildRunTerminalTelemetry({ run: { ...run, status: 'running' }, events: [], usage: noUsage })
    ).toBeUndefined();
  });

  test('projects node counts, the failure taxonomy and the exit reason from the log', async () => {
    const props = buildRunTerminalTelemetry({
      run,
      events: await failedRunEvents(),
      usage: noUsage,
    });
    expect(props).toMatchObject({
      outcome: 'failed',
      runId: 'run-1',
      isChild: false,
      nodesCompleted: 1,
      nodesFailed: 1,
      nodesTotal: 2,
      exitReason: 'node_error',
      errorClass: 'exec_failed',
    });
  });

  test.each([0, 0.25])('keeps reported cost %s', costUsd => {
    expect(buildRunTerminalTelemetry({ run, events: [], usage: { costUsd } })).toMatchObject({
      costUsd,
    });
  });

  test.each([
    ['completed', {}],
    ['failed', { exitReason: 'node_error' }],
    ['cancelled', { cancelReason: 'operator' }],
  ] as const)(
    'preserves the complete %s payload across resumed segments',
    async (status, reason) => {
      const childRun = {
        ...run,
        status,
        parent_run_id: 'parent',
        metadata: {
          ...run.metadata,
          [RUN_DISPATCH_METADATA_KEY]: { base_branch: 'dev', source: 'bundled' },
        },
      };
      const events: RunTelemetryEvent[] = [
        {
          event_type: 'workflow_started',
          data: { origin: 'cli', provider: 'claude', model: 'first-model' },
          created_at: '2026-09-24T10:00:00Z',
        },
        ...(await failedRunEvents()).filter(event => event.event_type !== 'workflow_failed'),
        {
          event_type: 'workflow_started',
          data: { origin: 'web', provider: 'codex', model: 'resumed-model' },
          created_at: '2026-09-24T10:01:00Z',
        },
        {
          ...serializeNodeStateRecord(
            finishNodeExecution(
              startNodeExecution({
                runId: run.id,
                path: 'build',
                node: { id: 'build', kind: 'exec', runtime: 'sh', script: 'work' },
                invocation: newNodeInvocation(),
              }),
              { status: 'failed', error: 'again', failureKind: 'transient' }
            )
          ),
          created_at: '2026-09-24T10:01:05Z',
        },
        { event_type: 'loop_iteration_completed', data: {}, created_at: '2026-09-24T10:00:06Z' },
        { event_type: 'loop_iteration_completed', data: {}, created_at: '2026-09-24T10:01:06Z' },
      ];
      const terminalRun = { ...childRun, outcome: null, output_root: null };
      const terminalRecord = buildTerminalRecord({
        run: terminalRun,
        events,
        artifacts: await observeRunArtifacts(terminalRun),
      });
      events.push(
        {
          event_type: TERMINAL_RUN_EVENT_TYPE[status],
          data: { exit_reason: 'unhandled_error', cancel_reason: 'halt_node' },
          created_at: '2026-09-24T10:01:30Z',
        },
        {
          event_type: TERMINAL_RUN_EVENT_TYPE[status],
          data: {
            terminal_record: terminalRecord,
            exit_reason: 'node_error',
            cancel_reason: 'operator',
          },
          created_at: '2026-09-24T10:02:00Z',
        }
      );
      expect(
        buildRunTerminalTelemetry({
          run: childRun,
          events,
          usage: {
            costUsd: 0,
            tokens: { input: 30, output: 5, cacheRead: 0, cacheWrite: 2, cachePartial: true },
          },
        })
      ).toEqual({
        outcome: status,
        runId: 'run-1',
        isChild: true,
        workflowName: 'implement',
        workflowSource: 'bundled',
        provider: 'claude',
        model: 'first-model',
        platform: 'cli',
        durationMs: 120000,
        nodesCompleted: 1,
        nodesFailed: 1,
        nodesSkipped: 0,
        nodesTotal: 2,
        ...reason,
        errorClass: 'transient',
        failedNodeType: 'bash',
        costUsd: 0,
        tokensIn: 30,
        tokensOut: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 2,
        cachePartialTokens: true,
        loopIterations: 2,
      });
    }
  );

  test('omits what the log does not know instead of inventing it', async () => {
    const props = buildRunTerminalTelemetry({
      run,
      events: await failedRunEvents(),
      usage: noUsage,
    });
    // No workflow_started row, no recorded source, no reported spend.
    for (const key of [
      'durationMs',
      'provider',
      'platform',
      'workflowSource',
      'costUsd',
      'tokensIn',
    ])
      expect(props).not.toHaveProperty(key);
  });
});

test('analytics terminal event mapping conforms to the persisted event owner', () => {
  expect(WORKFLOW_TERMINAL_EVENT_TYPE).toEqual(TERMINAL_RUN_EVENT_TYPE);
});
