import { describe, test, expect } from 'bun:test';
import { resolveExecutionNodeDisplay, resolveNodeDisplay, dagNodesToReactFlow } from './dag-layout';
import type { DagNode } from '@/lib/api';

type RouteLoopDagNode = DagNode & {
  route_loop: {
    from: string;
    condition: string;
    max_iterations: number;
    routes: {
      positive: string;
      negative: string;
      exhausted: string;
    };
  };
};

function routeLoopDagNodes(): DagNode[] {
  const routeLoopNode: RouteLoopDagNode = {
    id: 'review_router',
    depends_on: ['review'],
    route_loop: {
      from: 'review',
      condition: "$review.output.status == 'approved'",
      max_iterations: 3,
      routes: {
        positive: 'done',
        negative: 'fix',
        exhausted: 'escalate',
      },
    },
  };

  return [
    {
      id: 'fix',
      prompt: 'Revise the implementation based on the latest review.',
    },
    {
      id: 'review',
      depends_on: ['fix'],
      prompt: 'Review the implementation and emit JSON with a status field.',
    },
    routeLoopNode,
    {
      id: 'done',
      bash: "echo 'approved'",
    },
    {
      id: 'escalate',
      bash: "echo 'review exhausted'",
    },
  ];
}

describe('resolveNodeDisplay', () => {
  test('loop node returns label Loop, nodeType loop, and promptText from loop.prompt', () => {
    const dn: DagNode = {
      id: 'n1',
      loop: {
        prompt: 'process each item',
        until: 'done',
        max_iterations: 5,
        fresh_context: false,
      },
    };
    expect(resolveNodeDisplay(dn)).toEqual({
      label: 'Loop',
      nodeType: 'loop',
      promptText: 'process each item',
    });
  });

  test('approval node returns label Approval and nodeType approval', () => {
    const dn: DagNode = {
      id: 'n2',
      approval: { message: 'Please approve' },
    };
    expect(resolveNodeDisplay(dn)).toEqual({
      label: 'Approval',
      nodeType: 'approval',
    });
  });
});

describe('resolveExecutionNodeDisplay', () => {
  test('uses the node id as the execution graph label for prompt nodes', () => {
    const dn: DagNode = {
      id: 'cook',
      prompt: 'implement the verified plan',
    };

    expect(resolveExecutionNodeDisplay(dn)).toEqual({
      label: 'cook',
      nodeType: 'prompt',
      promptText: 'implement the verified plan',
    });
  });

  test('uses the node id as the execution graph label for bash nodes', () => {
    const dn: DagNode = {
      id: 'resolve-plan',
      bash: 'printf %s "$PLAN_DIR"',
      timeout: 5000,
    };

    expect(resolveExecutionNodeDisplay(dn)).toEqual({
      label: 'resolve-plan',
      nodeType: 'bash',
      bashScript: 'printf %s "$PLAN_DIR"',
      bashTimeout: 5000,
    });
  });

  test('uses the node id as the execution graph label for command nodes', () => {
    const dn: DagNode = {
      id: 'lint',
      command: 'check-code',
    };

    expect(resolveExecutionNodeDisplay(dn)).toEqual({
      label: 'lint',
      nodeType: 'command',
    });
  });
});

describe('dagNodesToReactFlow', () => {
  test('loop and approval nodes produce correct nodeType in ReactFlow output', () => {
    const loopNode: DagNode = {
      id: 'loop-1',
      loop: {
        prompt: 'iterate over results',
        until: 'complete',
        max_iterations: 10,
        fresh_context: true,
      },
    };
    const approvalNode: DagNode = {
      id: 'approval-1',
      depends_on: ['loop-1'],
      approval: { message: 'Review and approve' },
    };

    const { nodes } = dagNodesToReactFlow([loopNode, approvalNode]);

    expect(nodes).toHaveLength(2);
    const loopFlowNode = nodes.find(n => n.id === 'loop-1');
    const approvalFlowNode = nodes.find(n => n.id === 'approval-1');
    expect(loopFlowNode?.data.nodeType).toBe('loop');
    expect(approvalFlowNode?.data.nodeType).toBe('approval');
  });

  test('route_loop nodes create route edges to each configured target', () => {
    const { edges } = dagNodesToReactFlow(routeLoopDagNodes());

    expect(edges).toContainEqual(
      expect.objectContaining({
        id: 'review_router->done',
        source: 'review_router',
        target: 'done',
      })
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        id: 'review_router->fix',
        source: 'review_router',
        target: 'fix',
      })
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        id: 'review_router->escalate',
        source: 'review_router',
        target: 'escalate',
      })
    );
  });

  test('route_loop route edges include outcome labels', () => {
    const { edges } = dagNodesToReactFlow(routeLoopDagNodes());

    expect(edges).toContainEqual(
      expect.objectContaining({
        source: 'review_router',
        target: 'done',
        label: 'positive',
      })
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: 'review_router',
        target: 'fix',
        label: 'negative',
      })
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: 'review_router',
        target: 'escalate',
        label: 'exhausted',
      })
    );
  });

  test('route_loop route targets remain visible when they have no depends_on edge', () => {
    const { nodes } = dagNodesToReactFlow(routeLoopDagNodes());

    expect(nodes.map(node => node.id).sort()).toEqual([
      'done',
      'escalate',
      'fix',
      'review',
      'review_router',
    ]);
  });
});
