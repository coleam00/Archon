import { describe, test, expect } from 'bun:test';
import { FIXTURES } from '../fixtures';
import { fromWorkflowDefinition, toWorkflowDefinition } from '../model';
import type { BuilderNode, BuilderWorkflow } from '../types';
import { builderToFlow, builderToFlowEdges, edgeId } from './to-flow';
import { flowToBuilder } from './from-flow';
import { layoutWithDagre, NODE_HEIGHT } from './layout';
import type { XYPosition } from './types';

function bw(name: string): BuilderWorkflow {
  const fixture = FIXTURES[name];
  if (fixture === undefined) throw new Error(`unknown fixture: ${name}`);
  return fromWorkflowDefinition(fixture).workflow;
}

describe('builderToFlow', () => {
  test('maps every node with its variant label and synthesizes depends_on edges', () => {
    const workflow = bw('mixed');
    const { nodes, edges } = builderToFlow(workflow);

    expect(nodes.map(n => n.id)).toEqual(['classify', 'fix', 'report']);
    expect(nodes.every(n => n.type === 'builderNode')).toBe(true);
    expect(nodes[0]?.data.label).toBe('Prompt');
    expect(edges.map(e => e.id).sort()).toEqual([
      edgeId('classify', 'fix'),
      edgeId('classify', 'report'),
      edgeId('fix', 'report'),
    ]);
  });

  test('edges into a node with when: render dashed', () => {
    const edges = builderToFlowEdges(bw('mixed'));
    const intoFix = edges.find(e => e.target === 'fix');
    const intoReport = edges.find(e => e.target === 'report');
    expect(intoFix?.style?.strokeDasharray).toBe('6 4');
    expect(intoReport?.style?.strokeDasharray).toBeUndefined();
  });

  test('applies saved positions and dagre-layouts nodes missing one', () => {
    const workflow = bw('mixed');
    const saved = new Map<string, XYPosition>([['classify', { x: 7, y: 11 }]]);
    const { nodes } = builderToFlow(workflow, saved);
    const classify = nodes.find(n => n.id === 'classify');
    const fix = nodes.find(n => n.id === 'fix');
    expect(classify?.position).toEqual({ x: 7, y: 11 });
    // `fix` had no saved position — dagre placed it (not the 0,0 fallback).
    expect(fix?.position.y).toBeGreaterThan(0);
  });

  test('dangling depends_on produces no edge', () => {
    const workflow = bw('mixed');
    const withDangling: BuilderWorkflow = {
      ...workflow,
      nodes: workflow.nodes.map(n =>
        n.id === 'fix'
          ? ({ ...n, base: { ...n.base, depends_on: ['classify', 'ghost'] } } as BuilderNode)
          : n
      ),
    };
    const edges = builderToFlowEdges(withDangling);
    expect(edges.some(e => e.source === 'ghost')).toBe(false);
  });
});

describe('flowToBuilder round-trip', () => {
  for (const name of Object.keys(FIXTURES)) {
    test(`${name}: flowToBuilder(builderToFlow(bw)) preserves nodes, order, depends_on`, () => {
      const workflow = bw(name);
      const { nodes, edges } = builderToFlow(workflow);
      const rebuilt = flowToBuilder(nodes, edges, workflow);

      expect(rebuilt.name).toBe(workflow.name);
      expect(rebuilt.description).toBe(workflow.description);
      expect(rebuilt.meta).toEqual(workflow.meta);
      expect(rebuilt.nodes.map(n => n.id)).toEqual(workflow.nodes.map(n => n.id));
      // The wire definition is identical — positions are additive UI state.
      expect(toWorkflowDefinition(rebuilt)).toEqual(toWorkflowDefinition(workflow));
    });
  }

  test('dangling deps survive the round-trip (carried from the prior workflow)', () => {
    const workflow = bw('mixed');
    const withDangling: BuilderWorkflow = {
      ...workflow,
      nodes: workflow.nodes.map(n =>
        n.id === 'fix'
          ? ({ ...n, base: { ...n.base, depends_on: ['classify', 'ghost'] } } as BuilderNode)
          : n
      ),
    };
    const { nodes, edges } = builderToFlow(withDangling);
    const rebuilt = flowToBuilder(nodes, edges, withDangling);
    expect(rebuilt.nodes.find(n => n.id === 'fix')?.base.depends_on).toEqual(['classify', 'ghost']);
  });

  test('removing an edge removes the dependency', () => {
    const workflow = bw('mixed');
    const { nodes, edges } = builderToFlow(workflow);
    const without = edges.filter(e => e.id !== edgeId('fix', 'report'));
    const rebuilt = flowToBuilder(nodes, without, workflow);
    expect(rebuilt.nodes.find(n => n.id === 'report')?.base.depends_on).toEqual(['classify']);
  });
});

describe('layoutWithDagre', () => {
  test('positions every node, dependents below their dependencies', () => {
    const positions = layoutWithDagre(
      ['a', 'b', 'c'],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ]
    );
    const a = positions.get('a');
    const b = positions.get('b');
    const c = positions.get('c');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
    if (a && b && c) {
      expect(b.y).toBeGreaterThanOrEqual(a.y + NODE_HEIGHT);
      expect(c.y).toBeGreaterThanOrEqual(b.y + NODE_HEIGHT);
    }
  });

  test('skips edges referencing unknown ids instead of inventing nodes', () => {
    const positions = layoutWithDagre(['a'], [{ source: 'a', target: 'ghost' }]);
    expect([...positions.keys()]).toEqual(['a']);
  });
});
