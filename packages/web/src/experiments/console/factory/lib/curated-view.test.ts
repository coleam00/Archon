import { describe, expect, test } from 'bun:test';
import { shippedArrows, shippedFile, shippedGraph, shippedView } from '../curated.test-fixtures';
import { curatedView } from './curated-view';
import { mapColumns } from './map-columns';

const stage = (id: string) => shippedView.stages.find(entry => entry.id === id);

describe('the shipped file over the b62ec7b graph', () => {
  test('one map stage per card of the file, in its order, each with its graph stages', () => {
    expect(shippedView.stages.map(entry => [entry.id, entry.workflows])).toEqual([
      ['order', ['order']],
      ['triage', ['triage', 'split']],
      ['link', ['link']],
      ['plan', ['plan']],
      ['build', ['stage-build']],
      ['checks', ['stage-check']],
      ['host', ['stage-host']],
      ['ready', ['landgate', 'land', 'close']],
      ['landed', ['landed']],
    ]);
  });

  test("a card of one stage takes the stage's words; a card of several takes its own", () => {
    expect(stage('build')).toMatchObject({ label: 'Build', short: 'Writes the change and PR' });
    expect(stage('ready')).toMatchObject({
      label: 'Ready to merge',
      short: 'Gated, merged on land',
    });
  });

  test("a card of several stages tells their drill-downs in the card's order, each card covering its own stage's steps", () => {
    expect(stage('triage')?.drilldown?.phases.map(phase => phase.label)).toEqual([
      'Decide',
      'Follow up',
      'Split',
    ]);
    expect(stage('ready')?.drilldown?.phases.map(phase => phase.label)).toEqual([
      'Gate',
      'Merge',
      'Drop or reshape',
    ]);
    const [cut] = stage('triage')?.drilldown?.phases[2]?.cards ?? [];
    expect(cut?.covers).toEqual([{ workflow: 'split', steps: ['cut'] }]);
  });

  test("columns are the pack's groups, the last card its own column, in the stage colours then merged", () => {
    expect(
      mapColumns(shippedView).map(column => [column.label, column.stages, column.tone])
    ).toEqual([
      ['Intake', ['order', 'triage', 'link'], 'intake'],
      ['Plan and build', ['plan', 'build'], 'build'],
      ['Checks', ['checks', 'host'], 'check'],
      ['Ready to merge', ['ready'], 'land'],
      ['Merged', ['landed'], 'merged'],
    ]);
    expect(shippedView.landed.stage).toBe('landed');
  });

  test("the map's arrows are the graph's between cards, in the file's words", () => {
    const label = (from: string, to: string) =>
      shippedArrows.find(arrow => arrow.from === from && arrow.to === to)?.label;
    expect(label('order', 'triage')).toBe('ready');
    expect(label('checks', 'build')).toBe('returned');
    expect(label('ready', 'landed')).toBe('merged');
  });

  test('a card whose stages no group holds is a column of its own', () => {
    const view = curatedView(shippedFile, { ...shippedGraph, groups: [] });
    expect(view.columns.map(column => column.stages)).toEqual(view.stages.map(entry => [entry.id]));
  });
});
