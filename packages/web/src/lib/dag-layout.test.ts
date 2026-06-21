import { describe, test, expect } from 'bun:test';
import { resolveExecutionNodeDisplay, resolveNodeDisplay, dagNodesToReactFlow } from './dag-layout';
import type { DagNode } from '@/lib/api';

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
});
