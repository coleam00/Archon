import { describe, expect, test } from 'bun:test';
import { markedKeys, sortRows, type TableRow } from './board-table';

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

  test('sorted by Key, issue-N and N keys interleave by number, as the column shows them', () => {
    const rows = [row('issue-136', 1), row('140', 1), row('111', 1), row('issue-9', 1)];
    expect(keys(sortRows(rows, { by: 'key', descending: false }))).toEqual([
      'issue-9',
      '111',
      'issue-136',
      '140',
    ]);
  });

  test('sorted by Key, a split member sits right after its order, as it reads (#136 · …)', () => {
    const rows = [
      row('issue-137', 1),
      row('issue-136-item-keys', 1, 'landed', 'issue-136'),
      row('135', 1),
      row('issue-136', 1),
    ];
    expect(keys(sortRows(rows, { by: 'key', descending: false }))).toEqual([
      '135',
      'issue-136',
      'issue-136-item-keys',
      'issue-137',
    ]);
  });

  test('the median marks the middle row of an odd count, the two middle rows of an even one', () => {
    const odd = [row('a', 5), row('b', 1), row('c', 3), row('n', null)];
    expect([...markedKeys(odd, 'median', 'landed')]).toEqual(['c']);
    const even = [row('a', 5), row('b', 1), row('c', 3), row('d', 8)];
    expect([...markedKeys(even, 'median', 'landed')].sort()).toEqual(['a', 'c']);
    expect(markedKeys([row('n', null)], 'median', 'landed').size).toBe(0);
  });

  test('merged marks every row in the landed stage, none elsewhere', () => {
    const rows = [row('a', 1), row('b', null, 'build'), row('c', 2)];
    expect([...markedKeys(rows, 'landed', 'landed')]).toEqual(['a', 'c']);
  });
});
