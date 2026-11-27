import { describe, expect, test } from 'bun:test';
import { testArrows, testFile, testGraph, testView } from '../curated.test-fixtures';
import { curatedView } from './curated-view';
import { mapColumns } from './map-columns';
import { documentProblems } from './view-groups';

const stage = (id: string) => testView.stages.find(entry => entry.id === id);
const FLOW = [
  'order',
  'triage',
  'link',
  'split',
  'plan',
  'stage-build',
  'stage-check',
  'stage-host',
  'landgate',
  'land',
  'landed',
  'discoveries',
  'survey',
  'close',
  'order-done',
];

describe('the slim file over a pack graph', () => {
  test('one map stage per in-flow graph stage, in flow order, with its words from the file', () => {
    expect(testView.stages.map(entry => [entry.id, entry.workflows])).toEqual(
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
    expect(mapColumns(testView).map(column => [column.label, column.stages, column.tone])).toEqual([
      // Survey comes late in flow but sits in Intake, its group: a column is its group's stages.
      ['Intake', ['order', 'triage', 'link', 'split', 'survey'], 'intake'],
      ['Plan and build', ['plan', 'stage-build'], 'build'],
      ['Checks', ['stage-check', 'stage-host'], 'check'],
      ['Landing', ['landgate', 'land', 'discoveries', 'close', 'order-done'], 'land'],
      ['Merged', ['landed'], 'merged'],
    ]);
    expect(testView.landed.stage).toBe('landed');
    // Each group's line is the document's, served by the graph.
    expect(testView.columns.map(column => column.blurb).slice(0, 4)).toEqual(
      testGraph.groups.map(group => group.blurb ?? '')
    );
  });

  test("a group's colour is its document kind, so dropping a group moves no other's", () => {
    const groups = testGraph.groups.filter(group => group.name !== 'Plan and build');
    const tones = mapColumns(curatedView(testFile, { ...testGraph, groups })).map(column => [
      column.label,
      column.tone,
    ]);
    expect(tones).toContainEqual(['Checks', 'check']);
    expect(tones).toContainEqual(['Landing', 'land']);
  });

  test('a group with no kind, or one this console does not draw, reads neutral', () => {
    const groups = testGraph.groups.map(({ kind: _kind, ...group }, index) =>
      index === 0 ? { ...group, kind: 'intake-ish' } : group
    );
    const columns = mapColumns(curatedView(testFile, { ...testGraph, groups }));
    expect(columns.filter(column => column.tone !== 'merged').map(column => column.tone)).toEqual([
      'other',
      'other',
      'other',
      'other',
    ]);
    // Only the kind this console does not draw is a problem; none, or `neutral`, is not.
    expect(documentProblems({ document: null, groups })).toEqual([
      "group 'Intake' has kind 'intake-ish', which this console does not draw; it reads neutral",
    ]);
  });

  test('a stage no group holds is a column of its own, between the groups in flow order', () => {
    const groups = testGraph.groups.map(group => ({
      ...group,
      stages: group.stages.filter(stage => stage !== 'stage-host'),
    }));
    const columns = mapColumns(curatedView(testFile, { ...testGraph, groups }));
    expect(columns.map(column => [column.label, column.tone])).toEqual([
      ['Intake', 'intake'],
      ['Plan and build', 'build'],
      ['Checks', 'check'],
      [stage('stage-host')?.label ?? '', 'other'],
      ['Landing', 'land'],
      ['Merged', 'merged'],
    ]);
  });

  test('with no groups, every stage is a column of its own, never a group it is not in', () => {
    const columns = mapColumns(curatedView(testFile, { ...testGraph, groups: [] }));
    expect(columns.map(column => column.stages)).toEqual([
      ...FLOW.filter(id => id !== 'landed').map(id => [id]),
      ['landed'],
    ]);
    // A lone stage takes no group's colour or kind: Triage is not tagged "Build".
    expect(columns.find(column => column.id === 'triage')?.tone).toBe('other');
    expect(columns.at(-1)?.tone).toBe('merged');
  });

  test('a document that names no exit stage leaves the last in-flow stage there', () => {
    const { exit: _named, ...document } = testGraph.document!;
    const view = curatedView(testFile, { ...testGraph, document });
    expect([view.landed.stage, view.columns.at(-1)?.stages]).toEqual([
      'order-done',
      ['order-done'],
    ]);
  });

  test('a stage the pack gives no words is named by its id in words, not the raw id', () => {
    const stages = testGraph.stages.map(({ display, ...stage }) =>
      stage.workflow === 'stage-host' ? stage : { ...stage, display }
    );
    const view = curatedView(testFile, { ...testGraph, stages });
    expect(view.stages.find(entry => entry.id === 'stage-host')?.label).toBe('Stage host');
  });
});

describe("the map's arrows over a pack graph", () => {
  const label = (from: string, to: string) =>
    testArrows.find(arrow => arrow.from === from && arrow.to === to)?.label;

  test("each pair is labelled with the file's outcome and answer labels, never an option id", () => {
    // Triage's park waits on link over a depends_on link, which moves no item: it is left out.
    expect(label('triage', 'link')).toBe('build, narrow');
    expect(label('link', 'plan')).toBe('placed');
    expect(label('stage-build', 'close')).toBe('dropped by you, needs shaping');
    expect(label('stage-check', 'stage-build')).toBe(
      'returned, sent back, one more round, something else'
    );
    expect(label('land', 'landed')).toBe('merged');
    expect(label('plan', 'plan')).toBe('answered');
    expect(label('link', 'link')).toBe('asked');
  });
});
