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

const arrow = (
  from: string,
  to: string,
  linked: Arrow['linked'] = null,
  outcome = 'done'
): Arrow => ({
  from: { stage: `o/p:${from}`, outcome },
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
    arrow('triage', 'plan', null, 'whole'),
    arrow('triage', 'link'),
    arrow('triage', 'plan', null, 'small'),
    arrow('triage', 'plan', null, 'whole'),
    arrow('link', 'plan', null, 'placed'),
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
  outcomeLabels: {},
};

/** The same view, with the file wording triage's `whole` exactly and link's outcomes by `link:*`. */
const worded: StructureView = {
  ...view,
  outcomeLabels: { 'triage:whole': 'kept whole', 'link:*': 'linked' },
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

  test("the map's arrows: the graph's between stages in its order, each pair labelled with its values once, wake-ups and drains left out", () => {
    expect(mapArrows(view, graph)).toEqual([
      { from: 'intake', to: 'plan', label: 'whole, small' },
      { from: 'intake', to: 'link', label: 'done' },
      { from: 'link', to: 'plan', label: 'placed' },
      { from: 'link', to: 'link', label: 'done' },
    ]);
  });

  test("an outcome reads as the file's label where it gives one, exact before the stage's catch-all", () => {
    expect(mapArrows(worded, graph)).toEqual([
      { from: 'intake', to: 'plan', label: 'kept whole, small' },
      { from: 'intake', to: 'link', label: 'done' },
      { from: 'link', to: 'plan', label: 'linked' },
      { from: 'link', to: 'link', label: 'linked' },
    ]);
  });

  test('where items go from a stage: its arrows into other stages, in the same words', () => {
    expect(stageHandOffs(view, mapArrows(view, graph), 'link')).toEqual([
      { label: 'placed', to: 'plan', toLabel: 'Plan' },
    ]);
    expect(stageHandOffs(worded, mapArrows(worded, graph), 'intake')).toEqual([
      { label: 'kept whole, small', to: 'plan', toLabel: 'Plan' },
      { label: 'done', to: 'link', toLabel: 'Link' },
    ]);
  });
});
