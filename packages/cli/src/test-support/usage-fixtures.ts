import {
  finishNodeExecution,
  newNodeInvocation,
  startNodeExecution,
} from '@archon/workflows/node-execution';
import { serializeNodeStateRecord } from '@archon/workflows/node-record-serialization';
import type { SerializedNodeEvent } from '@archon/workflows/node-record-serialization';

export function usageEvents(runId: string, mixed = false): SerializedNodeEvent[] {
  return ['build', 'review'].map((path, index) => {
    const start = startNodeExecution({
      runId,
      path,
      node: { id: path, kind: 'agent', source: { kind: 'inline', prompt: 'PRIVATE_PROMPT' } },
      invocation: newNodeInvocation(),
      provider: mixed && index === 1 ? 'codex' : 'claude',
      sessionId: 'PRIVATE_SESSION',
    });
    const record = finishNodeExecution(
      start,
      { status: 'completed' },
      {
        costUsd: mixed && index === 1 ? undefined : 0.25,
        tokens: { input: 4, output: 2 },
        output: { text: 'PRIVATE_OUTPUT' },
      }
    );
    if (mixed && index === 1)
      record.spend.costUsd = { source: 'unavailable', reason: 'unsupported' };
    return serializeNodeStateRecord(record);
  });
}
