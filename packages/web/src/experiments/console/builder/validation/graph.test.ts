import { describe, test, expect } from 'bun:test';
import { validateGraph } from './graph';
import type { BuilderNode, BuilderWorkflow } from '../types';

function promptNode(id: string, dependsOn?: string[]): BuilderNode {
  return {
    id,
    variant: 'prompt',
    base: dependsOn ? { depends_on: dependsOn } : {},
    data: { prompt: 'x' },
  };
}

function wf(nodes: BuilderNode[]): BuilderWorkflow {
  return { name: 'g', description: 'd', meta: {}, nodes };
}

describe('validateGraph', () => {
  test('valid DAG produces no issues', () => {
    const issues = validateGraph(
      wf([promptNode('a'), promptNode('b', ['a']), promptNode('c', ['a', 'b'])])
    );
    expect(issues).toEqual([]);
  });

  test('unknown depends_on ref is flagged', () => {
    const issues = validateGraph(wf([promptNode('a', ['ghost'])]));
    expect(issues.some(i => i.rule === 'graph.ref.unknown')).toBe(true);
  });

  test('self-loop is detected', () => {
    const issues = validateGraph(wf([promptNode('a', ['a'])]));
    expect(issues.some(i => i.rule === 'graph.cycle')).toBe(true);
  });

  test('two-node cycle is detected', () => {
    const issues = validateGraph(wf([promptNode('a', ['b']), promptNode('b', ['a'])]));
    expect(issues.some(i => i.rule === 'graph.cycle')).toBe(true);
  });

  test('three-node cycle is detected', () => {
    const issues = validateGraph(
      wf([promptNode('a', ['c']), promptNode('b', ['a']), promptNode('c', ['b'])])
    );
    expect(issues.some(i => i.rule === 'graph.cycle')).toBe(true);
  });

  test('a long acyclic chain does not false-positive a cycle', () => {
    const issues = validateGraph(
      wf([promptNode('a'), promptNode('b', ['a']), promptNode('c', ['b']), promptNode('d', ['c'])])
    );
    expect(issues.filter(i => i.rule === 'graph.cycle')).toEqual([]);
  });
});
