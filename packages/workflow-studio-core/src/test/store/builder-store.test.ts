import { describe, it, expect, beforeEach } from 'bun:test';
import { useBuilderStore } from '../../store/builder-store';

const initial = useBuilderStore.getState();

describe('builder-store', () => {
  beforeEach(() => useBuilderStore.getState().clearWorkflow());

  it('starts empty', () => {
    expect(useBuilderStore.getState().workflow).toBeNull();
    expect(useBuilderStore.getState().nodes).toEqual([]);
  });

  it('loadWorkflow seeds workflow + nodes', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [{ id: 'a', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    expect(useBuilderStore.getState().workflow?.name).toBe('w');
    expect(useBuilderStore.getState().nodes).toHaveLength(1);
  });

  it('updateNode patches data.command', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [{ id: 'a', variant: 'command', data: { command: 'foo' }, base: {}, unknown: {} }],
    });
    useBuilderStore.getState().updateNode('a', { data: { command: 'bar' } });
    const a = useBuilderStore.getState().nodes.find(n => n.id === 'a')!;
    expect((a.data as { command: string }).command).toBe('bar');
  });

  it('renameNode cascades through depends_on', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [
        { id: 'classify', variant: 'command', data: { command: 'c' }, base: {}, unknown: {} },
        {
          id: 'act',
          variant: 'command',
          data: { command: 'a' },
          base: { depends_on: ['classify'] },
          unknown: {},
        },
      ],
    });
    useBuilderStore.getState().renameNode('classify', 'sort');
    const act = useBuilderStore.getState().nodes.find(n => n.id === 'act')!;
    expect(act.base.depends_on).toEqual(['sort']);
  });

  it('renameNode cascades through when: strings', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [
        { id: 'classify', variant: 'command', data: { command: 'c' }, base: {}, unknown: {} },
        {
          id: 'act',
          variant: 'command',
          data: { command: 'a' },
          base: { when: "$classify.output == 'ok'" },
          unknown: {},
        },
      ],
    });
    useBuilderStore.getState().renameNode('classify', 'sort');
    const act = useBuilderStore.getState().nodes.find(n => n.id === 'act')!;
    expect(act.base.when).toBe("$sort.output == 'ok'");
  });

  it('renameNode cascades through body-text refs in prompt/bash/script/loop/approval', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [
        { id: 'classify', variant: 'command', data: { command: 'c' }, base: {}, unknown: {} },
        {
          id: 'p1',
          variant: 'prompt',
          data: { prompt: 'Use $classify.output to decide' },
          base: {},
          unknown: {},
        },
        {
          id: 'b1',
          variant: 'bash',
          data: { bash: 'echo "$classify.output"' },
          base: {},
          unknown: {},
        },
        {
          id: 's1',
          variant: 'script',
          data: { script: "console.log('$classify.output')", runtime: 'bun' as const },
          base: {},
          unknown: {},
        },
        {
          id: 'l1',
          variant: 'loop',
          data: {
            loop: {
              prompt: 'Iterate using $classify.output',
              until: 'COMPLETE',
              max_iterations: 5,
              fresh_context: false,
            },
          },
          base: {},
          unknown: {},
        },
        {
          id: 'a1',
          variant: 'approval',
          data: { approval: { message: 'Approve $classify.output?' } },
          base: {},
          unknown: {},
        },
        // Negative case: word boundary — $classify_v2 should NOT be rewritten.
        {
          id: 'p2',
          variant: 'prompt',
          data: { prompt: '$classify_v2.output is unrelated' },
          base: {},
          unknown: {},
        },
      ],
    });
    useBuilderStore.getState().renameNode('classify', 'sort');
    const find = (id: string) =>
      useBuilderStore.getState().nodes.find(n => n.id === id)! as {
        data: Record<string, unknown>;
      };
    expect(find('p1').data.prompt).toBe('Use $sort.output to decide');
    expect(find('b1').data.bash).toBe('echo "$sort.output"');
    expect(find('s1').data.script).toBe("console.log('$sort.output')");
    expect((find('l1').data.loop as Record<string, unknown>).prompt).toBe(
      'Iterate using $sort.output'
    );
    expect((find('a1').data.approval as Record<string, unknown>).message).toBe(
      'Approve $sort.output?'
    );
    // Word-boundary protection
    expect(find('p2').data.prompt).toBe('$classify_v2.output is unrelated');
  });

  it('renameNode rejects collisions', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [
        { id: 'a', variant: 'command', data: { command: 'a' }, base: {}, unknown: {} },
        { id: 'b', variant: 'command', data: { command: 'b' }, base: {}, unknown: {} },
      ],
    });
    expect(() => useBuilderStore.getState().renameNode('a', 'b')).toThrow();
  });

  describe('addNodeFromVariant', () => {
    it('mints a node with a default id from the variant library hint', () => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [],
      });
      const id = useBuilderStore.getState().addNodeFromVariant('command');
      expect(id).toBe('run-command'); // command/data.ts:defaultIdHint
      expect(useBuilderStore.getState().nodes).toHaveLength(1);
      expect(useBuilderStore.getState().nodes[0]!.variant).toBe('command');
    });

    it('disambiguates the id when the default collides', () => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [
          { id: 'run-command', variant: 'command', data: { command: 'x' }, base: {}, unknown: {} },
        ],
      });
      const id = useBuilderStore.getState().addNodeFromVariant('command');
      expect(id).toBe('run-command-2');
    });

    it('respects idHintOverride and dataPatch (used by commands list)', () => {
      useBuilderStore.getState().loadWorkflow({
        meta: { name: 'w', description: '', base: {}, unknown: {} },
        nodes: [],
      });
      const id = useBuilderStore.getState().addNodeFromVariant('command', {
        idHintOverride: 'run-classify',
        dataPatch: { command: 'classify' },
      });
      expect(id).toBe('run-classify');
      expect(useBuilderStore.getState().nodes[0]!.data).toMatchObject({ command: 'classify' });
    });
  });

  it('deleteNodes removes target + clears references in others depends_on', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'w', description: 'd', base: {}, unknown: {} },
      nodes: [
        { id: 'a', variant: 'command', data: { command: 'a' }, base: {}, unknown: {} },
        {
          id: 'b',
          variant: 'command',
          data: { command: 'b' },
          base: { depends_on: ['a'] },
          unknown: {},
        },
      ],
    });
    useBuilderStore.getState().deleteNodes(['a']);
    const nodes = useBuilderStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.base.depends_on).toBeUndefined();
  });
});

describe('builder-store — Phase 7 slice', () => {
  beforeEach(() => {
    useBuilderStore.setState(initial, true);
  });

  it('hoveredNodeId defaults to null and is settable', () => {
    expect(useBuilderStore.getState().hoveredNodeId).toBeNull();
    useBuilderStore.getState().setHoveredNodeId('x');
    expect(useBuilderStore.getState().hoveredNodeId).toBe('x');
    useBuilderStore.getState().setHoveredNodeId(null);
    expect(useBuilderStore.getState().hoveredNodeId).toBeNull();
  });

  it('isYamlPreviewOpen defaults to false and toggles', () => {
    expect(useBuilderStore.getState().isYamlPreviewOpen).toBe(false);
    useBuilderStore.getState().setYamlPreviewOpen(true);
    expect(useBuilderStore.getState().isYamlPreviewOpen).toBe(true);
  });

  it('loadWorkflow seeds baselineYaml from the loaded input', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'n', description: 'd', base: {}, unknown: {} },
      nodes: [{ id: 'a', variant: 'prompt', data: { prompt: 'x' }, base: {}, unknown: {} }],
    });
    const baseline = useBuilderStore.getState().baselineYaml;
    expect(typeof baseline).toBe('string');
    expect(baseline).toContain('name: n');
    expect(baseline).toContain('id: a');
  });

  it('opening the drawer does not change baseline', () => {
    useBuilderStore.getState().loadWorkflow({
      meta: { name: 'n', description: 'd', base: {}, unknown: {} },
      nodes: [],
    });
    const before = useBuilderStore.getState().baselineYaml;
    useBuilderStore.getState().setYamlPreviewOpen(true);
    expect(useBuilderStore.getState().baselineYaml).toBe(before);
  });
});
