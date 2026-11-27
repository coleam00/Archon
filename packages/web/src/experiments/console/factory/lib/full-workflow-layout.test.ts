import { describe, expect, test } from 'bun:test';
import type { PackGraph } from '../../skills/items';
import { columnsOf, type StageGroup } from '../../routes/BoardPage';
import { testGraph, testView } from '../curated.test-fixtures';
import { LIVE_FITTING } from '../map/useMapCamera';
import { fullWorkflowLayout, MERGED } from './full-workflow-layout';
import { mapArrows, type StructureView } from './graph-structure';
import { fitCamera } from './map-camera';
import { boxesMeet } from './map-geometry.test-fixtures';
import { groupsOf } from './view-groups';

describe("a pack's full workflow", () => {
  const layout = fullWorkflowLayout(testGraph, columnsOf(testGraph, groupsOf(testGraph)), testView);
  const named = layout.arrows.map(arrow => ({
    name: `${arrow.from}>${arrow.to} [${arrow.lines.join('/')}]`,
    box: arrow.pillBox,
  }));

  test('no pill meets another pill', () => {
    expect(named.length).toBeGreaterThan(1);
    const faults: string[] = [];
    named.forEach((pill, i) =>
      named.forEach((other, j) => {
        if (i < j && boxesMeet(pill.box, other.box)) faults.push(`${pill.name} | ${other.name}`);
      })
    );
    expect(faults).toEqual([]);
  });

  test('no pill meets a card', () => {
    const faults = named.flatMap(pill =>
      layout.cards
        .filter(card => boxesMeet(pill.box, card.box))
        .map(card => `${pill.name} | ${card.id}`)
    );
    expect(faults).toEqual([]);
  });

  test('every pill sits inside the bounds the camera fits', () => {
    const { bounds } = layout;
    for (const { box } of named) {
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.w).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(box.y + box.h).toBeLessThanOrEqual(bounds.y + bounds.h);
    }
  });

  // DESIGN, rule 1 (#219): the Full workflow opens fitted, down to a scale of 0.4, so every
  // stage shows at once. The send-back lanes under the cards may run below the frame and pan.
  test('every stage opens inside the Overview frame at 1440x900 (about 1110x720)', () => {
    const frame = { width: 1110, height: 720 };
    const { pad } = LIVE_FITTING;
    const camera = fitCamera(layout.bounds, frame, pad, 0.4, 1);
    const { bounds } = layout;
    expect(camera.k).toBeGreaterThanOrEqual(0.4);
    expect(bounds.x * camera.k + camera.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y * camera.k + camera.y).toBeGreaterThanOrEqual(0);
    expect((bounds.x + bounds.w) * camera.k + camera.x).toBeLessThanOrEqual(frame.width);
    for (const { box } of layout.cards)
      expect((box.y + box.h) * camera.k + camera.y).toBeLessThanOrEqual(frame.height);
  });
});

type Arrow = PackGraph['arrows'][number];
type Stage = PackGraph['stages'][number];

const stage = (name: string, ends: string[] = []): Stage => ({
  name: `o/p:${name}`,
  workflow: name,
  entry: false,
  roles: [],
  inFlow: true,
  waits: false,
  returns: null,
  outcome: {
    field: 'verdict',
    form: 'enum',
    values: ends.map(value => ({ value, startsNothing: true, ends: true, stops: false })),
  },
  observes: false,
  asks: true,
  nodes: [],
});

const edge = (from: string, to: string, by: Arrow['from']): Arrow => ({
  from: by,
  to: `o/p:${to}`,
  linked: null,
  active: false,
  declared: { binding: `${from}-${to}`, problems: [] },
  installed: null,
});

const outcome = (from: string, to: string, value: string): Arrow =>
  edge(from, to, { stage: `o/p:${from}`, outcome: value });
const answer = (from: string, to: string, option: string): Arrow =>
  edge(from, to, { stage: `o/p:${from}`, settled: 'answered', option });

describe('the full workflow words its pills as the curated map does', () => {
  // a lands into b or stops; b's asks send it back or settle as `other`; w stops into c; c lands.
  const graph = {
    pack: 'o.p',
    stages: [stage('a'), stage('b'), stage('w'), stage('c', ['land'])],
    arrows: [
      outcome('a', 'b', 'land'),
      answer('b', 'a', 'send-back'),
      answer('b', 'a', 'other'),
      outcome('w', 'c', 'broken'),
      outcome('w', 'c', 'dropped'),
    ],
  } as unknown as PackGraph;
  const view: StructureView = {
    stages: ['a', 'b', 'w', 'c'].map(id => ({ id, label: id, workflows: [id] })),
    runNames: Object.fromEntries(graph.stages.map(entry => [entry.workflow, entry.name])),
    outcomeLabels: { 'a:land': 'merge it', 'c:land': 'merged', 'w:*': 'stopped' },
    answerLabels: { 'b:send-back': 'sent back' },
  };
  const groups: StageGroup[] = ['a', 'b', 'w', 'c'].map(id => ({ name: id, stages: [id] }));
  const layout = fullWorkflowLayout(graph, groups, view);
  const pill = (from: string, to: string): string[] | undefined =>
    layout.arrows.find(arrow => arrow.from === from && arrow.to === to)?.lines;
  const mapWords = (from: string, to: string): string[] | undefined =>
    mapArrows(view, graph)
      .find(arrow => arrow.from === from && arrow.to === to)
      ?.label.split(', ');

  test("an outcome arrow and an answer arrow read the view's labels, not their ids", () => {
    expect(pill('a', 'b')).toEqual(['merge it']);
    expect(pill('b', 'a')).toContain('sent back');
    expect(pill('b', 'a')).not.toContain('send-back');
  });

  test('the final outcome into Merged reads its outcome label, as any outcome does', () => {
    expect(pill('c', MERGED)).toEqual(['merged']);
  });

  test('every pill between two stages reads exactly what the curated map reads for that pair', () => {
    for (const [from, to] of [
      ['a', 'b'],
      ['b', 'a'],
      ['w', 'c'],
    ] as const)
      expect(pill(from, to)).toEqual(mapWords(from, to));
  });
});
