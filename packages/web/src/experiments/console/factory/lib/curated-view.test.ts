import { describe, expect, test } from 'bun:test';
import { shippedArrows, shippedFile, shippedGraph, shippedView } from '../curated.test-fixtures';
import { curatedView } from './curated-view';
import { mapColumns } from './map-columns';

const stage = (id: string) => shippedView.stages.find(entry => entry.id === id);
const FLOW = [
  'order',
  'triage',
  'link',
  'split',
  'complexity',
  'plan',
  'attend',
  'stage-build',
  'stage-check',
  'stage-host',
  'catchup',
  'landgate',
  'land',
  'landed',
  'discoveries',
  'close',
];

describe('the slim file over the af6d0b4a graph', () => {
  test('one map stage per in-flow graph stage, in flow order, with its words from the file', () => {
    expect(shippedView.stages.map(entry => [entry.id, entry.workflows])).toEqual(
      FLOW.map(workflow => [workflow, [workflow]])
    );
    expect(stage('stage-build')).toMatchObject({
      label: 'Build',
      short: 'Writes the change and PR',
    });
    const [cut] = stage('split')?.drilldown?.phases[0]?.cards ?? [];
    expect(cut?.covers).toEqual([{ workflow: 'split', steps: ['cut'] }]);
  });

  test('columns are the groups with their stages in flow order, then the merged stage alone', () => {
    expect(
      mapColumns(shippedView).map(column => [column.label, column.stages, column.tone])
    ).toEqual([
      ['Intake', ['order', 'triage', 'link', 'split', 'complexity'], 'intake'],
      ['Plan and build', ['plan', 'attend', 'stage-build'], 'build'],
      ['Checks', ['stage-check', 'stage-host', 'catchup'], 'check'],
      ['Landing', ['landgate', 'land', 'discoveries', 'close'], 'land'],
      ['Merged', ['landed'], 'merged'],
    ]);
    expect(shippedView.landed.stage).toBe('landed');
  });

  test("a graph with no groups draws the file's groups, each column headed by its group", () => {
    const view = curatedView(shippedFile, { ...shippedGraph, groups: [] });
    expect(mapColumns(view).map(column => [column.label, column.blurb, column.tone])).toEqual(
      mapColumns(shippedView).map(column => [column.label, column.blurb, column.tone])
    );
  });

  test("a group's colour is its declared kind, so dropping a group moves no other's", () => {
    const groups = (shippedFile.groups ?? []).filter(group => group.name !== 'Plan and build');
    const tones = mapColumns(curatedView({ ...shippedFile, groups }, shippedGraph)).map(column => [
      column.label,
      column.tone,
    ]);
    expect(tones).toContainEqual(['Checks', 'check']);
    expect(tones).toContainEqual(['Landing', 'land']);
  });

  test('a group that declares no kind reads neutral', () => {
    const groups = (shippedFile.groups ?? []).map(({ kind: _kind, ...group }) => group);
    const columns = mapColumns(curatedView({ ...shippedFile, groups }, shippedGraph));
    expect(columns.filter(column => column.tone !== 'merged').map(column => column.tone)).toEqual([
      'other',
      'other',
      'other',
      'other',
    ]);
  });

  test("where the graph and the file both group, the file's groups win", () => {
    const graph = { ...shippedGraph, groups: [{ name: 'Everything', stages: [...FLOW] }] };
    expect(curatedView(shippedFile, graph).columns.map(column => column.label)).toEqual([
      'Intake',
      'Plan and build',
      'Checks',
      'Landing',
      'Merged',
    ]);
  });

  test('with no groups anywhere, every stage is a column of its own, never a group it is not in', () => {
    const { groups: _none, ...file } = shippedFile;
    const columns = mapColumns(curatedView(file, { ...shippedGraph, groups: [] }));
    expect(columns.map(column => column.stages)).toEqual([
      ...FLOW.filter(id => id !== 'landed').map(id => [id]),
      ['landed'],
    ]);
    // A lone stage takes no group's colour or kind: Triage is not tagged "Build".
    expect(columns.find(column => column.id === 'triage')?.tone).toBe('other');
    expect(columns.at(-1)?.tone).toBe('merged');
  });

  test('a file that names no merged stage leaves the last in-flow stage there', () => {
    const { merged: _named, ...file } = shippedFile;
    const view = curatedView(file, shippedGraph);
    expect([view.landed.stage, view.columns.at(-1)?.stages]).toEqual(['close', ['close']]);
  });

  test('a stage the file gives no words is named by its id in words, not the raw id', () => {
    const { 'stage-host': _host, ...stages } = shippedFile.stages;
    const view = curatedView({ ...shippedFile, stages }, shippedGraph);
    expect(view.stages.find(entry => entry.id === 'stage-host')?.label).toBe('Stage host');
  });
});

describe("the map's arrows over the af6d0b4a graph", () => {
  const label = (from: string, to: string) =>
    shippedArrows.find(arrow => arrow.from === from && arrow.to === to)?.label;

  test("each pair is labelled with the file's outcome labels, and an ask's answers as the graph names them", () => {
    expect(label('triage', 'link')).toBe('build, narrow');
    expect(label('link', 'plan')).toBe('placed');
    expect(label('stage-build', 'close')).toBe('drop, reshape');
    expect(label('stage-check', 'stage-build')).toBe('returned, send-back, one-more-round, other');
    expect(label('land', 'landed')).toBe('merged');
    expect(label('plan', 'plan')).toBe('answered');
    expect(label('link', 'link')).toBe('asked');
  });
});
