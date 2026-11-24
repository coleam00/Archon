import { describe, expect, test } from 'bun:test';
import { boardModel } from './board';
import { FIXTURE_NOW, PAGE, VIEW } from './board.test-fixtures';
import { markedKeys, sortRows, tableRows, type TableRow } from './board-table';

const HOUR = 3_600_000;
const START = '2026-11-17T10:00:00Z';

/** A row whose item merged `hours` after its one declared run started; never merged when null. */
function row(
  key: string,
  hours: number | null,
  stage = 'landed',
  order: string | null = null
): TableRow {
  const mergedAt = hours === null ? null : new Date(Date.parse(START) + hours * HOUR).toISOString();
  return {
    placed: {
      card: { key, pill: 'landed', order },
      column: { stage: { id: stage } },
      item: {
        progress: { change: { mergedAt }, runs: [{ runId: `r${key}` }] },
        runs: [{ id: `r${key}`, startedAt: START }],
      },
    },
    column: 'Merged',
    columnOrder: 0,
    stage: null,
    stageOrder: 0,
  } as unknown as TableRow;
}

const keys = (rows: readonly TableRow[]): string[] => rows.map(r => r.placed.card.key);

describe('the Table under a number', () => {
  test('sorted by time to merge, a row with none comes after every time, either way', () => {
    const rows = [row('a', 5), row('b', null), row('c', 1), row('d', 3)];
    expect(keys(sortRows(rows, { by: 'toLand', descending: false }))).toEqual(['c', 'd', 'a', 'b']);
    expect(keys(sortRows(rows, { by: 'toLand', descending: true }))).toEqual(['a', 'd', 'c', 'b']);
  });

  test('rows name the column and stage; by stage they sort down the pipeline, Merged last', () => {
    const rows = tableRows(
      boardModel(VIEW, 'cb-1', [...PAGE.items].reverse(), new Map(), FIXTURE_NOW)
    );
    const sorted = sortRows(rows, { by: 'stage', descending: false });
    expect(sorted.map(r => [r.placed.card.key, r.column, r.stage])).toEqual([
      ['3', 'Plan & build', 'Build'],
      ['6', 'Plan & build', 'Build'],
      ['4', 'Plan & build', 'Build'],
      ['5', 'Plan & build', 'Build'],
      ['8', 'Checks & review', 'Checks'],
      // A merged row's Stage is empty, as its card's is.
      ['1', 'Merged', null],
      ['2', 'Merged', null],
      ['7', 'Merged', null],
    ]);
  });

  test('sorted by work order, rows with none come last', () => {
    const rows = [row('a', 1), row('b', 1, 'landed', '48'), row('c', 1, 'landed', '60')];
    expect(keys(sortRows(rows, { by: 'order', descending: true }))).toEqual(['c', 'b', 'a']);
  });

  test('sorted by Key, issue-N and N keys interleave by number, as the column shows them', () => {
    const rows = [row('issue-136', 1), row('140', 1), row('111', 1), row('issue-9', 1)];
    expect(keys(sortRows(rows, { by: 'key', descending: false }))).toEqual([
      'issue-9',
      '111',
      'issue-136',
      '140',
    ]);
  });

  test('the median marks the middle row of an odd count, the two middle rows of an even one', () => {
    const odd = [row('a', 5), row('b', 1), row('c', 3), row('n', null)];
    expect([...markedKeys(odd, 'median', 'landed')]).toEqual(['c']);
    const even = [row('a', 5), row('b', 1), row('c', 3), row('d', 8)];
    expect([...markedKeys(even, 'median', 'landed')].sort()).toEqual(['a', 'c']);
  });

  test('merged marks every row in the landed stage, none elsewhere', () => {
    const rows = [row('a', 1), row('b', null, 'build'), row('c', 2)];
    expect([...markedKeys(rows, 'landed', 'landed')]).toEqual(['a', 'c']);
  });
});
