import { describe, expect, test } from 'bun:test';
import type { Edge } from '@xyflow/react';
import { reactFlowToDagNodes } from './WorkflowCanvas';
import type { DagFlowNode } from './DagNodeComponent';

describe('reactFlowToDagNodes route_loop serialization', () => {
  test('uses route_loop node data instead of stale route edges', () => {
    const nodes = [
      {
        id: 'review-router',
        type: 'dagNode',
        position: { x: 0, y: 0 },
        data: {
          id: 'review-router',
          label: 'Route',
          nodeType: 'route_loop',
          route_loop: {
            from: 'new-review',
            condition: "$new-review.output.result == 'positive'",
            max_iterations: 3,
            routes: {
              positive: 'done-from-inspector',
              negative: 'fix',
              exhausted: 'escalate',
            },
          },
        },
      },
    ] as DagFlowNode[];
    const edges = [
      {
        id: 'old-review->review-router',
        source: 'old-review',
        target: 'review-router',
      },
      {
        id: 'review-router->stale-done:positive',
        source: 'review-router',
        sourceHandle: 'positive',
        target: 'stale-done',
      },
    ] satisfies Edge[];

    const [routeNode] = reactFlowToDagNodes(nodes, edges);

    expect(routeNode.depends_on).toEqual(['new-review']);
    expect('route_loop' in routeNode).toBe(true);
    if (!('route_loop' in routeNode)) throw new Error('expected route_loop node');
    expect(routeNode.route_loop).toMatchObject({
      from: 'new-review',
      routes: {
        positive: 'done-from-inspector',
        negative: 'fix',
        exhausted: 'escalate',
      },
    });
  });
});
