import { describe, test, expect } from 'bun:test';
import { deriveNodeStatuses, type WorkflowGraphNode } from './workflow-graph';

describe('deriveNodeStatuses', () => {
  const graph: WorkflowGraphNode[] = [
    { id: 'prepare', dependsOn: [], kind: 'bash' },
    { id: 'flaky', dependsOn: ['prepare'], kind: 'prompt' },
    { id: 'report', dependsOn: ['flaky'], kind: 'prompt' },
  ];

  test("each graph node takes the engine's state, and an unlisted node is pending", () => {
    const statuses = deriveNodeStatuses(graph, [
      { node_id: 'prepare', state: 'pending' },
      { node_id: 'flaky', state: 'failed', error: 'boom' },
    ]);
    expect(statuses.map(n => [n.id, n.status])).toEqual([
      ['prepare', 'pending'],
      ['flaky', 'failed'],
      ['report', 'pending'],
    ]);
  });
});
