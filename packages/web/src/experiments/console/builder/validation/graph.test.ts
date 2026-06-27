import { describe, test, expect } from 'bun:test';
import type { BuilderNode } from '../types';
import { validateGraph } from './graph';
import { promptNode, wf } from './test-helpers';

function routeLoopNode(
  id: string,
  dependsOn: string[],
  data?: Partial<Extract<BuilderNode, { variant: 'route_loop' }>['data']>
): BuilderNode {
  return {
    id,
    variant: 'route_loop',
    base: { depends_on: dependsOn },
    data: {
      from: 'review',
      condition: "$review.output.status == 'approved'",
      max_iterations: 3,
      routes: {
        positive: 'done',
        negative: 'fix',
        exhausted: 'escalate',
      },
      ...data,
    },
  };
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

  test('route_loop with one input and all route targets produces no issues', () => {
    const issues = validateGraph(
      wf([
        promptNode('fix'),
        promptNode('review', ['fix']),
        routeLoopNode('review_router', ['review']),
        promptNode('done'),
        promptNode('escalate'),
      ])
    );
    expect(issues).toEqual([]);
  });

  test('route_loop with a second input is flagged', () => {
    const issues = validateGraph(
      wf([
        promptNode('fix'),
        promptNode('review', ['fix']),
        routeLoopNode('review_router', ['review', 'fix']),
        promptNode('done'),
        promptNode('escalate'),
      ])
    );
    expect(
      issues.some(
        i =>
          i.rule === 'graph.route_loop.input.count' &&
          i.path.nodeId === 'review_router' &&
          i.path.field === 'depends_on'
      )
    ).toBe(true);
  });

  test('route_loop missing a required route target is flagged', () => {
    const issues = validateGraph(
      wf([
        promptNode('fix'),
        promptNode('review', ['fix']),
        routeLoopNode('review_router', ['review'], {
          routes: { positive: 'done', negative: '', exhausted: 'escalate' },
        }),
        promptNode('done'),
        promptNode('escalate'),
      ])
    );
    expect(
      issues.some(
        i =>
          i.rule === 'graph.route_loop.route.missing' &&
          i.path.nodeId === 'review_router' &&
          i.path.field === 'route_loop.routes.negative'
      )
    ).toBe(true);
  });

  test('route_loop route target that does not exist is flagged', () => {
    const issues = validateGraph(
      wf([
        promptNode('fix'),
        promptNode('review', ['fix']),
        routeLoopNode('review_router', ['review'], {
          routes: { positive: 'done', negative: 'fix', exhausted: 'ghost' },
        }),
        promptNode('done'),
      ])
    );
    expect(
      issues.some(
        i =>
          i.rule === 'graph.route_loop.route.unknown' &&
          i.path.nodeId === 'review_router' &&
          i.path.field === 'route_loop.routes.exhausted'
      )
    ).toBe(true);
  });

  test('route_loop allows shared route targets', () => {
    const issues = validateGraph(
      wf([
        promptNode('fix'),
        promptNode('review', ['fix']),
        routeLoopNode('review_router', ['review'], {
          routes: { positive: 'done', negative: 'fix', exhausted: 'fix' },
        }),
        promptNode('done'),
      ])
    );
    expect(issues).toEqual([]);
  });

  test('route_loop from that does not match its input is flagged', () => {
    const issues = validateGraph(
      wf([
        promptNode('fix'),
        promptNode('review', ['fix']),
        routeLoopNode('review_router', ['review'], { from: 'fix' }),
        promptNode('done'),
        promptNode('escalate'),
      ])
    );
    expect(
      issues.some(
        i =>
          i.rule === 'graph.route_loop.from.mismatch' &&
          i.path.nodeId === 'review_router' &&
          i.path.field === 'route_loop.from'
      )
    ).toBe(true);
  });
});
