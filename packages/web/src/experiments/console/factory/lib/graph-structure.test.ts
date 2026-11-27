import { describe, expect, test } from 'bun:test';
import type { PackGraph } from '../../skills/items';
import {
  mapArrows,
  outcomeLabel,
  outcomeWords,
  stageHandOffs,
  stageSteps,
  type StructureView,
} from './graph-structure';

type Arrow = PackGraph['arrows'][number];
type Stage = PackGraph['stages'][number];

const stage = (name: string, nodes: string[]): Stage => ({
  name: `o/p:${name}`,
  workflow: name,
  entry: false,
  roles: [],
  inFlow: true,
  waits: false,
  options: null,
  returns: nodes.at(-1) ?? null,
  outcome: null,
  observes: false,
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
  answerLabels: {},
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

  test("the map's arrows: the graph's between stages in its order, each pair labelled with its values in words once, wake-ups and drains left out", () => {
    expect(mapArrows(view, graph)).toEqual([
      { from: 'intake', to: 'plan', label: 'Whole, Small' },
      { from: 'intake', to: 'link', label: 'Done' },
      { from: 'link', to: 'plan', label: 'Placed' },
      { from: 'link', to: 'link', label: 'Done' },
    ]);
  });

  test("an outcome reads as the file's label where it gives one, exact before the stage's catch-all", () => {
    expect(mapArrows(worded, graph)).toEqual([
      { from: 'intake', to: 'plan', label: 'kept whole, Small' },
      { from: 'intake', to: 'link', label: 'Done' },
      { from: 'link', to: 'plan', label: 'linked' },
      { from: 'link', to: 'link', label: 'linked' },
    ]);
  });

  test("an answer arrow reads as the file's label for its option; an option with none reads as its id", () => {
    const answered = (option: string): Arrow => ({
      ...arrow('plan', 'triage'),
      from: { stage: 'o/p:plan', settled: 'answered', option },
    });
    const asked = { ...graph, arrows: [answered('take-as-is'), answered('other')] } as PackGraph;
    const [back] = mapArrows({ ...view, answerLabels: { 'plan:take-as-is': 'kept' } }, asked);
    expect(back).toEqual({ from: 'plan', to: 'intake', label: 'kept, other' });
    expect(back?.label).not.toContain('take-as-is');
  });

  test('where items go from a stage: its arrows into other stages, in the same words', () => {
    expect(stageHandOffs(view, mapArrows(view, graph), 'link')).toEqual([
      { label: 'Placed', to: 'plan', toLabel: 'Plan' },
    ]);
    expect(stageHandOffs(worded, mapArrows(worded, graph), 'intake')).toEqual([
      { label: 'kept whole, Small', to: 'plan', toLabel: 'Plan' },
      { label: 'Done', to: 'link', toLabel: 'Link' },
    ]);
  });

  test('a hand-off to a stage the view does not name reads as its id in words, never the id (#261)', () => {
    const arrows = [{ from: 'plan', to: 'stage-host', label: 'done' }] as Parameters<
      typeof stageHandOffs
    >[1];
    expect(stageHandOffs({ stages: [] }, arrows, 'plan')).toEqual([
      { label: 'done', to: 'stage-host', toLabel: 'Stage host' },
    ]);
  });
});

describe('an outcome reads its label, else its value in words (#270)', () => {
  const labels = {
    outcomeLabels: { 'build:ask': 'asked you', 'build:*': 'Build ended' },
  };

  test('an exact workflow:outcome label wins over workflow:*', () => {
    expect(outcomeWords(labels, 'build', 'ask')).toBe('asked you');
  });

  test('workflow:* words an outcome the file does not list', () => {
    expect(outcomeWords(labels, 'build', 'drop')).toBe('Build ended');
    expect(outcomeLabel(labels, 'build', null)).toBe('Build ended');
  });

  test('an outcome the file does not word reads as its value in words', () => {
    expect(outcomeWords(labels, 'check', 'send-back')).toBe('Send back');
    expect(outcomeLabel(labels, 'check', 'pass')).toBeUndefined();
  });
});
