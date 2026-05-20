import { describe, it, expect } from 'bun:test';
import { fromWorkflowDefinition } from '../../exporter/fromWorkflowDefinition';

describe('fromWorkflowDefinition', () => {
  it('imports a minimal command workflow', () => {
    const result = fromWorkflowDefinition({
      name: 'w',
      description: 'd',
      nodes: [{ id: 'a', command: 'classify' }],
    });
    expect(result.meta.name).toBe('w');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.variant).toBe('command');
    expect((result.nodes[0]!.data as { command: string }).command).toBe('classify');
  });

  it('captures unknown workflow-base + node-level keys', () => {
    const result = fromWorkflowDefinition({
      name: 'w',
      description: 'd',
      future_workflow_knob: 'experimental',
      nodes: [{ id: 'a', command: 'classify', __experimental_node_flag: true }],
    });
    expect(result.meta.unknown).toEqual({ future_workflow_knob: 'experimental' });
    expect(result.nodes[0]!.unknown).toEqual({ __experimental_node_flag: true });
  });

  it('partitions every variant correctly across a mixed workflow', () => {
    const result = fromWorkflowDefinition({
      name: 'mixed',
      description: 'all variants',
      nodes: [
        { id: 'c', command: 'foo' },
        { id: 'p', prompt: 'do', depends_on: ['c'] },
        { id: 'b', bash: 'echo', timeout: 1000 },
        { id: 's', script: 'export {}', runtime: 'bun' },
        { id: 'l', loop: { prompt: 'p', until: 'X', max_iterations: 3 } },
        { id: 'a', approval: { message: 'go?' } },
        { id: 'x', cancel: 'abort' },
      ],
    });
    expect(result.nodes.map(n => n.variant)).toEqual([
      'command',
      'prompt',
      'bash',
      'script',
      'loop',
      'approval',
      'cancel',
    ]);
  });
});
