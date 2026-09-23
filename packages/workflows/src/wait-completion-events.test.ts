import { describe, expect, it } from 'bun:test';
import { startNodeExecution, finishNodeExecution, newNodeInvocation } from './node-execution';
import { serializeNodeStateRecord } from './node-record-serialization';
import { waitCompletionEvents } from './store';

const satisfied = {
  stepName: 'await-ci',
  result: { status: 'satisfied', waited_ms: 4200 } as const,
};

describe('waitCompletionEvents', () => {
  it('derives both rows from one result', () => {
    const rows = waitCompletionEvents('run-1', satisfied);
    expect(rows.outcome).toEqual({
      workflow_run_id: 'run-1',
      event_type: 'wait_completed',
      step_name: 'await-ci',
      data: satisfied.result,
    });
    expect(rows.node).toEqual({
      workflow_run_id: 'run-1',
      event_type: 'node_completed',
      step_name: 'await-ci',
      data: {
        type: 'wait',
        duration_ms: 4200,
        node_output: JSON.stringify(satisfied.result),
        structured_output: satisfied.result,
      },
    });
  });

  it('an expired event wait records wait_expired and still completes the node', () => {
    const rows = waitCompletionEvents('run-2', {
      stepName: 'await-signal',
      result: { status: 'expired', waited_ms: 60000, event: 'ci.concluded' },
    });
    expect(rows.outcome.event_type).toBe('wait_expired');
    expect(rows.node.event_type).toBe('node_completed');
    expect(rows.node.data?.duration_ms).toBe(60000);
  });

  it('returns the exact execution projection for a transactional resumed wait', () => {
    const execution = finishNodeExecution(
      startNodeExecution({
        runId: 'run-1',
        path: satisfied.stepName,
        node: { id: 'await-ci', kind: 'wait', wait: { duration_ms: 4200 } },
        invocation: newNodeInvocation(),
      }),
      { status: 'completed' },
      {
        durationMs: 4200,
        output: { text: JSON.stringify(satisfied.result), structured: satisfied.result },
      }
    );
    expect(waitCompletionEvents('run-1', { ...satisfied, execution }).node).toEqual(
      serializeNodeStateRecord(execution)
    );
  });
});
