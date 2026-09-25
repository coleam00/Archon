import { describe, expect, test } from 'bun:test';
import { buildRunTerminalTelemetry, type RunTelemetryEvent } from './run-terminal-telemetry';
import { buildTerminalRecord } from './terminal-record';
import { RUN_GRAPH_METADATA_KEY } from './schemas/terminal-record';

const run = {
  id: 'run-1',
  workflow_name: 'implement',
  parent_run_id: null,
  status: 'failed' as const,
  metadata: { [RUN_GRAPH_METADATA_KEY]: { node_ids: ['plan', 'build'] } },
};
const noUsage = { costUsd: 0 };

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
  const terminalRecord = await buildTerminalRecord({
    run: { ...run, outcome: null, output_root: null },
    events,
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
