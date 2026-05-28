import { describe, expect, test } from 'bun:test';
import type { Edge } from '@xyflow/react';
import type { DagNode } from '@/lib/api';
import { dagNodesToReactFlow, resolveNodeDisplay } from './dag-layout';
import { reactFlowToDagNodes } from '@/components/workflows/WorkflowCanvas';

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

describe('DAG layout loop node support', () => {
  test('loads loop nodes as loop nodes with nested prompt data', () => {
    const dagNodes: DagNode[] = [
      {
        id: 'iterate',
        model: 'claude-opus-4-6',
        idle_timeout: 600000,
        loop: {
          prompt: 'Do the next task',
          until: 'COMPLETE',
          max_iterations: 5,
          fresh_context: false,
          interactive: true,
          gate_message: 'Approve next iteration',
        },
      } as DagNode,
    ];

    const { nodes } = dagNodesToReactFlow(dagNodes);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].data.nodeType).toBe('loop');
    expect(nodes[0].data.label).toBe('Loop');
    expect(nodes[0].data.promptText).toBe('Do the next task');
    expect(nodes[0].data.loop?.prompt).toBe('Do the next task');
  });

  test('round-trips loop nodes without converting them to prompt nodes', () => {
    const dagNodes: DagNode[] = [
      {
        id: 'setup',
        bash: 'echo ready',
      } as DagNode,
      {
        id: 'iterate',
        depends_on: ['setup'],
        model: 'claude-opus-4-6',
        provider: 'claude',
        idle_timeout: 600000,
        loop: {
          prompt: 'Use $setup.output and iterate',
          until: 'COMPLETE',
          max_iterations: 10,
          fresh_context: true,
          until_bash: 'test -f done.txt',
        },
      } as DagNode,
    ];
    const { nodes, edges } = dagNodesToReactFlow(dagNodes);

    const roundTripped = reactFlowToDagNodes(nodes, edges as Edge[]);
    const loopNode = roundTripped.find(node => node.id === 'iterate');

    if (loopNode === undefined || !('loop' in loopNode) || loopNode.loop === undefined) {
      throw new Error('Expected iterate to round-trip as a loop node');
    }

    expect(loopNode && 'prompt' in loopNode).toBe(false);
    expect(loopNode?.depends_on).toEqual(['setup']);
    expect(loopNode?.model).toBe('claude-opus-4-6');
    expect(loopNode?.provider).toBe('claude');
    expect(loopNode?.idle_timeout).toBe(600000);
    expect(loopNode.loop.prompt).toBe('Use $setup.output and iterate');
    expect(loopNode.loop.max_iterations).toBe(10);
    expect(loopNode.loop.until_bash).toBe('test -f done.txt');
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
