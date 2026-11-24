import { expect, test } from 'bun:test';
import type { FactoryDeclaration } from './board';
import { boardColumns } from './board-columns';
import { VIEW } from './board.test-fixtures';

test("the shipped view's columns, in order, each in its stage group's colour or merged", () => {
  expect(boardColumns(VIEW).map(column => [column.id, column.stages, column.tone])).toEqual([
    ['intake', ['order', 'triage'], 'intake'],
    ['plan-build', ['plan', 'build'], 'build'],
    ['checks-review', ['checks', 'host'], 'check'],
    ['ready', ['ready'], 'land'],
    ['merged', ['landed'], 'merged'],
  ]);
});

test('a view without columns has one column per stage, with its label and blurb', () => {
  const { columns: _, ...older } = VIEW;
  const columns = boardColumns(older as FactoryDeclaration);
  expect(columns).toHaveLength(8);
  expect(columns[0]).toEqual({
    id: 'order',
    label: 'Order',
    blurb:
      'Takes a work order, or an issue someone added the factory label to, and makes it one item the factory can read.',
    stages: ['order'],
    tone: 'intake',
  });
  expect(columns[3]).toEqual({
    id: 'build',
    label: 'Build',
    blurb: 'Writes the change and opens a draft pull request, then fixes what comes back.',
    stages: ['build'],
    tone: 'build',
  });
  expect(columns[7]).toEqual({
    id: 'landed',
    label: 'Merged',
    blurb: 'The change is merged.',
    stages: ['landed'],
    tone: 'merged',
  });
});
