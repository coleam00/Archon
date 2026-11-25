import { describe, expect, test } from 'bun:test';
import type { PackGraph } from '../../skills/items';
import { mapArrows, stageHandOffs, stageSteps, type StructureView } from './graph-structure';

type Arrow = PackGraph['arrows'][number];
type Stage = PackGraph['stages'][number];

const stage = (name: string, nodes: string[]): Stage => ({
  name: `o/p:${name}`,
  workflow: name,
  entry: false,
  roles: [],
  inFlow: true,
  waits: false,
  returns: nodes.at(-1) ?? null,
  outcome: null,
  asks: false,
  nodes: nodes.map(id => ({
    id,
    kind: 'agent',
    dependsOn: [],
    loopGroup: null,
    blocks: [],
    fanOut: null,
  })),
});

const arrow = (from: string, to: string, linked: Arrow['linked'] = null): Arrow => ({
  from: { stage: `o/p:${from}`, outcome: 'done' },
  to: `o/p:${to}`,
  linked,
  active: false,
  declared: { binding: `${from}-${to}`, problems: [] },
  installed: null,
});

const dependsOn: Arrow['linked'] = { kind: 'depends_on', holder: 'from', entries: {} };

/** triage hands to link and plan; link waits on others (depends_on) and hands to plan; a drain. */
const graph = {
  pack: 'o.p',
  stages: [
    stage('triage', ['judge', 'admit']),
    stage('link', ['given', 'link', 'end']),
    stage('plan', ['plan']),
    stage('drain', ['drain']),
  ],
  arrows: [
    arrow('triage', 'plan'),
    arrow('triage', 'link'),
    arrow('link', 'plan'),
    arrow('plan', 'link', dependsOn),
    arrow('plan', 'drain'),
    arrow('link', 'link'),
  ],
  fanOutBlocks: [],
  discoveryErrors: [],
} as unknown as PackGraph;

const view: StructureView = {
  stages: [
    { id: 'intake', label: 'Intake', workflows: ['triage'] },
    { id: 'link', label: 'Link', workflows: ['link'] },
    { id: 'plan', label: 'Plan', workflows: ['plan'] },
  ],
  runNames: { triage: 'o/p:triage', link: 'o/p:link', plan: 'o/p:plan' },
  map: {
    arrows: [
      { from: 'link', to: 'plan', label: 'placed' },
      { from: 'intake', to: 'plan', label: 'kept whole' },
    ],
  },
};

describe('the structure the pack graph gives', () => {
  test("a stage's steps are the graph's nodes of each graph stage it stands for", () => {
    expect(stageSteps(view.stages[0] ?? { workflows: [] }, graph)).toEqual([
      { workflow: 'triage', steps: ['judge', 'admit'] },
    ]);
    expect(stageSteps({ workflows: ['link', 'gone'] }, graph)).toEqual([
      { workflow: 'link', steps: ['given', 'link', 'end'] },
      { workflow: 'gone', steps: undefined },
    ]);
  });

  test("the map's arrows: the graph's between stages, labelled ones first, wake-ups and drains left out", () => {
    expect(mapArrows(view, graph)).toEqual([
      { from: 'link', to: 'plan', label: 'placed' },
      { from: 'intake', to: 'plan', label: 'kept whole' },
      { from: 'intake', to: 'link', label: undefined },
      { from: 'link', to: 'link', label: undefined },
    ]);
  });

  test('a label for a pair the graph does not connect draws nothing', () => {
    const labelled = { ...view, map: { arrows: [{ from: 'plan', to: 'intake', label: 'back' }] } };
    expect(mapArrows(labelled, graph).some(a => a.from === 'plan')).toBe(false);
  });

  test('where items go from a stage: its arrows into other stages, by label', () => {
    const arrows = mapArrows(view, graph);
    expect(stageHandOffs(view, arrows, 'link')).toEqual([
      { label: 'placed', to: 'plan', toLabel: 'Plan' },
    ]);
  });
});
