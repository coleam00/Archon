import { describe, expect, it } from 'bun:test';
import { planGraph, resolveWorkflow, resolvedBodyNodes } from './graph-plan';
import type { AgentNode, IncludeDirective, LoopGroupNodeConfig, ResolvedWorkflow } from './schemas';

function node(id: string, depends_on?: string[]): AgentNode {
  return {
    id,
    kind: 'agent',
    source: { kind: 'command', name: id },
    ...(depends_on?.length ? { depends_on } : {}),
  };
}

describe('planGraph', () => {
  it('single node with no dependencies -> one layer', () => {
    const layers = planGraph([node('a')]).layers;
    expect(layers).toHaveLength(1);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
  });

  it('linear chain -> one node per layer', () => {
    const layers = planGraph([node('a'), node('b', ['a']), node('c', ['b'])]).layers;
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
    expect(layers[1].map(n => n.id)).toEqual(['b']);
    expect(layers[2].map(n => n.id)).toEqual(['c']);
  });

  it('fan-out: classify -> [investigate, plan] in same layer', () => {
    const layers = planGraph([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
    ]).layers;
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    const layer1Ids = layers[1].map(n => n.id).sort();
    expect(layer1Ids).toEqual(['investigate', 'plan']);
  });

  it('fan-in: [a, b] -> implement in its own layer', () => {
    const layers = planGraph([node('a'), node('b'), node('implement', ['a', 'b'])]).layers;
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'b']);
    expect(layers[1].map(n => n.id)).toEqual(['implement']);
  });

  it('diamond: classify -> [investigate, plan] -> implement', () => {
    const layers = planGraph([
      node('classify'),
      node('investigate', ['classify']),
      node('plan', ['classify']),
      node('implement', ['investigate', 'plan']),
    ]).layers;
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['classify']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['investigate', 'plan']);
    expect(layers[2].map(n => n.id)).toEqual(['implement']);
  });

  it('orders the next layer by when each dependent becomes ready', () => {
    const plan = planGraph([
      node('a'),
      node('b'),
      node('joint', ['a', 'b']),
      node('only-b', ['b']),
      node('only-a', ['a']),
    ]);
    expect(plan.layers.map(layer => layer.map(item => item.id))).toEqual([
      ['a', 'b'],
      ['only-a', 'joint', 'only-b'],
    ]);
  });

  it('throws on a cyclic graph', () => {
    const cyclic = [node('a', ['b']), node('b', ['a'])];
    expect(() => planGraph(cyclic)).toThrow('Cycle detected');
  });

  it('self-referential node throws', () => {
    const selfRef = [node('a', ['a'])];
    expect(() => planGraph(selfRef)).toThrow('Cycle detected');
  });

  it('two independent chains share layers correctly', () => {
    const layers = planGraph([node('a'), node('b', ['a']), node('c'), node('d', ['c'])]).layers;
    expect(layers).toHaveLength(2);
    expect(layers[0].map(n => n.id).sort()).toEqual(['a', 'c']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['b', 'd']);
  });

  it('records every sink in definition order', () => {
    const plan = planGraph([node('root'), node('left', ['root']), node('right', ['root'])]);
    expect(plan.sinks).toEqual(['left', 'right']);
  });

  it('attaches the complete plan to a resolved workflow', () => {
    const workflow = resolveWorkflow({
      name: 'representative',
      description: 'representative',
      nodes: [node('root'), node('left', ['root']), node('right', ['root'])],
    });

    expect(workflow.plan.layers.map(layer => layer.map(item => item.id))).toEqual([
      ['root'],
      ['left', 'right'],
    ]);
    expect(workflow.plan.sinks).toEqual(['left', 'right']);
    expect(workflow.nodes).toBe(workflow.plan.nodes);

    // biome-ignore lint/correctness/noConstantCondition: compile-time assertions that never run
    if (false) {
      // @ts-expect-error Resolved workflow nodes are immutable after planning.
      workflow.nodes.push(node('late'));
      // @ts-expect-error The plan exposes the same immutable node set.
      workflow.plan.nodes.splice(0, 1);
      // @ts-expect-error Planned layers cannot be mutated after construction.
      workflow.plan.layers[0]?.push(node('late'));
    }
  });

  it('does not let a typed caller pair a plan with another node set', () => {
    const first = resolveWorkflow({ name: 'first', description: 'first', nodes: [node('first')] });
    const second = resolveWorkflow({
      name: 'second',
      description: 'second',
      nodes: [node('second')],
    });

    // @ts-expect-error Object spread loses the factory-only resolved-workflow identity.
    const mismatched: ResolvedWorkflow = { ...first, nodes: second.nodes };
    expect(mismatched.plan.nodes).not.toBe(mismatched.nodes);
  });

  it('rejects an include directive that survived expansion and names it', () => {
    const include: IncludeDirective = { id: 'block', kind: 'include', include: 'child' };
    expect(() => planGraph([include])).toThrow("include node 'block'");
    expect(() =>
      resolveWorkflow({ name: 'invalid', description: 'invalid', nodes: [include] })
    ).toThrow("include node 'block'");
  });
});

describe('resolvedBodyNodes', () => {
  it('rejects an include directive in a nested body and names it', () => {
    const include: IncludeDirective = { id: 'nested', kind: 'include', include: 'child' };
    const group: LoopGroupNodeConfig = {
      until: 'DONE',
      max_iterations: 1,
      fresh_context: false,
      nodes: [include],
    };
    expect(() => resolvedBodyNodes(group)).toThrow("include node 'nested'");
  });
});
