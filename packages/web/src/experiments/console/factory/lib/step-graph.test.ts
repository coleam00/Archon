import { describe, expect, test } from 'bun:test';
import type { FactoryWorkflow } from '../../skills/factory';
import deliverJson from './fixtures/deliver-workflow.json';
import { stepGraph } from './step-graph';
import { layoutStepGraph, type Box } from './step-graph-layout';
import { stepWorker, type FactoryStage } from './stage-steps';
import { VIEW } from './board.test-fixtures';
import { stepLabel } from './step-label';

/**
 * `GET /api/factory/workflow` for the software factory pack's `deliver`, as the server
 * returned it from the installed pack, with each prompt and YAML block cut to its first line.
 */
const deliver = deliverJson as FactoryWorkflow;

// The Checks stage of the pack's factory view (.archon/packs/*.factory-view.json).
const checks = {
  nodes: [
    'rounds.base',
    'rounds.review__review',
    'rounds.tests__tests',
    'rounds.product__product',
    'rounds.verdict__verdict',
    'exhausted',
  ],
};

// The view's stages, Checks listing the steps this fixture of deliver has.
const stages = VIEW.stages.map(stage => (stage.id === 'checks' ? { ...stage, ...checks } : stage));
const stageOf = (id: string): FactoryStage => {
  const stage = stages.find(candidate => candidate.id === id);
  if (stage === undefined) throw new Error(`the view has no stage ${id}`);
  return stage;
};
const name = (key: string): string => stepLabel(VIEW, 'deliver', key);
const graph = stepGraph(
  deliver,
  key => stepWorker(stages, stageOf('checks'), 'deliver', key),
  name
);
const groupOf = (key: string): string | null =>
  graph.nodes.find(node => node.key === key)?.group ?? null;

describe('stepGraph on deliver', () => {
  test('the rounds loop holds the fix, base and every check, each check its own include', () => {
    const group = (id: string) => graph.groups.find(candidate => candidate.id === id);
    expect(group('rounds')).toMatchObject({
      kind: 'loop',
      parent: null,
      label: 'Check rounds',
      maxRounds: 3,
    });
    expect(group('build')).toMatchObject({ kind: 'include', parent: null, label: 'build' });
    expect([groupOf('rounds.fix'), groupOf('rounds.base')]).toEqual(['rounds', 'rounds']);
    for (const check of ['review', 'tests', 'product', 'verdict']) {
      expect(groupOf(`rounds.${check}__${check}`)).toBe(`rounds.${check}`);
      expect(group(`rounds.${check}`)).toMatchObject({
        kind: 'include',
        parent: 'rounds',
        label: check,
      });
    }
    // A step reads by its name, never its engine id.
    const label = (key: string) => graph.nodes.find(node => node.key === key)?.label;
    expect([label('build__build'), label('rounds.review__review')]).toEqual([
      'Writes the change',
      'Code review',
    ]);
  });

  test('a wait on a loop runs from its last step, and the loop starts at its first', () => {
    const edges = graph.edges.map(edge => `${edge.from}→${edge.to}`);
    for (const edge of [
      'rounds.verdict__verdict→exhausted',
      'build__build→rounds.fix',
      'rounds.verdict__verdict→hostrounds.hostfix',
      'hostrounds.host__host→result',
    ])
      expect(edges).toContain(edge);
    expect(edges).not.toContain('rounds.base→exhausted');
    // build enters the loop at fix only, not at every step of it.
    expect(edges).not.toContain('build__build→rounds.base');
    expect(new Set(edges).size).toBe(edges.length);
    const keys = new Set(graph.nodes.map(node => node.key));
    for (const edge of graph.edges)
      expect([keys.has(edge.from), keys.has(edge.to)]).toEqual([true, true]);
  });

  test('a step and a loop print their when: in short, each step it reads by its name', () => {
    const condition = (key: string) => graph.nodes.find(node => node.key === key)?.condition;
    expect(condition('rounds.fix')).toBe('if Verdict = return');
    expect(condition('exhausted')).toBe('if Check rounds = return');
    expect(condition('hostrounds.hostfix')).toBe('if Reads CI and PR reviews = return');
    expect(condition('rounds.base')).toBeNull();
    expect(graph.groups.find(group => group.id === 'hostrounds')?.condition).toBe(
      'if Check rounds = approve'
    );
  });

  test("only the Checks stage's steps are its own", () => {
    expect(graph.nodes.filter(node => node.worker.kind === 'this').map(node => node.key)).toEqual(
      checks.nodes
    );
  });

  test('every other step names the stage that works it, from the view file', () => {
    const workers = new Map(graph.nodes.map(node => [node.key, node.worker]));
    expect(workers.get('build__build')).toEqual({
      kind: 'other',
      stage: { id: 'build', label: stageOf('build').label, group: 'build' },
    });
    expect(workers.get('hostrounds.host__host')).toMatchObject({
      kind: 'other',
      stage: { id: 'host' },
    });
    expect([...workers.values()].filter(worker => worker.kind === 'none')).toEqual([]);
  });
});

describe('layoutStepGraph on deliver', () => {
  const laid = layoutStepGraph(graph);
  const inside = (inner: Box, outer: Box): boolean =>
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
  const groupBox = (id: string) => laid.groups.find(group => group.group.id === id);

  test('every step lies inside its group, and every group inside its parent', () => {
    for (const step of laid.steps) {
      if (step.node.group === null) continue;
      const box = groupBox(step.node.group);
      expect(box && inside(step, box)).toBe(true);
    }
    for (const group of laid.groups) {
      if (group.group.parent === null) continue;
      const parent = groupBox(group.group.parent);
      expect(parent && inside(group, parent)).toBe(true);
    }
  });

  test('draws top to bottom: a step sits below the steps it waits on', () => {
    const top = new Map(laid.steps.map(step => [step.node.key, step.y]));
    for (const edge of laid.edges)
      expect((top.get(edge.to) ?? 0) > (top.get(edge.from) ?? 0)).toBe(true);
  });
});
