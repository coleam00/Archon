import {
  finishNodeExecution,
  newNodeInvocation,
  startNodeExecution,
} from '@archon/workflows/node-execution';
import { serializeNodeStateRecord } from '@archon/workflows/node-record-serialization';
import type { WorkflowEventRow } from '@archon/workflows/schemas/workflow-event';

export function throughputEvents(
  runId: string,
  output = 100,
  durationMs = 1000
): WorkflowEventRow[] {
  const records = [
    finishNodeExecution(
      startNodeExecution({
        runId,
        path: 'work',
        node: { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'work' } },
        invocation: newNodeInvocation(),
        provider: 'claude',
        model: 'large',
      }),
      { status: 'completed' },
      { tokens: { input: 10, output }, durationMs }
    ),
    finishNodeExecution(
      startNodeExecution({
        runId,
        path: 'review',
        node: { id: 'review', kind: 'agent', source: { kind: 'inline', prompt: 'review' } },
        invocation: newNodeInvocation(),
        provider: 'codex',
        model: 'small',
      }),
      { status: 'completed' },
      { tokens: { input: 10, output: 900 }, durationMs: 9000 }
    ),
    finishNodeExecution(
      startNodeExecution({
        runId,
        path: 'missing',
        node: { id: 'missing', kind: 'agent', source: { kind: 'inline', prompt: 'work' } },
        invocation: newNodeInvocation(),
        provider: 'claude',
        model: 'large',
      }),
      { status: 'completed' },
      { durationMs: 300000 }
    ),
    finishNodeExecution(
      startNodeExecution({
        runId,
        path: 'ci',
        node: { id: 'ci', kind: 'wait', wait: { duration_ms: 300000 } },
        invocation: newNodeInvocation(),
      }),
      { status: 'completed' },
      { durationMs: 300000 }
    ),
  ];
  return records.map((record, i) => ({
    ...serializeNodeStateRecord(record),
    id: `${runId}-${i}`,
    step_index: i,
    created_at: '2026-11-07T00:00:00Z',
  }));
}
