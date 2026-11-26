import { describe, expect, test } from 'bun:test';
import { CHIP } from '../../routes/board/standing';
import type { ItemRead } from '../../skills/items';
import { shippedView } from '../curated.test-fixtures';
import { itemOn } from '../items.test-fixtures';
import { itemStateLine } from './item-state';

const ended = (workflow: string, outcome: string): ItemRead => {
  const read = itemOn('x', workflow, 'done');
  const [run] = read.runs;
  return { ...read, runs: run === undefined ? [] : [{ ...run, outcome }] };
};

describe("an item's state line", () => {
  test('a merged item reads Merged, never the workflow it last ran', () => {
    const line = itemStateLine(
      shippedView,
      { ...itemOn('m', 'landed', 'done'), merged: { at: '2026-11-24T10:00:00Z' } } as ItemRead,
      null,
      false
    );
    expect(line.tone).toBe('merged');
    expect(line.text).toContain('Merged');
    expect(line.text).not.toContain('landed');
  });

  test("a running item reads the board card's running stage and step", () => {
    const line = itemStateLine(
      shippedView,
      itemOn('b', 'stage-build', 'running'),
      {
        stage: 'Build',
        step: 'Writes or fixes the change',
      },
      false
    );
    expect(line.tone).toBe('running');
    expect(line.text).toContain('Build');
    expect(line.text).toContain('Writes or fixes the change');
  });

  test("before the card's records answer, a running item names its stage by the file's label", () => {
    const line = itemStateLine(shippedView, itemOn('b', 'stage-build', 'running'), null, false);
    expect(line.tone).toBe('running');
    expect(line.text).toContain('Build');
    expect(line.text).not.toContain('stage-build');
  });

  test('an item with open asks needs you, at its stage in the file’s words', () => {
    const line = itemStateLine(shippedView, itemOn('a', 'landgate', 'waiting'), null, true);
    expect(line.tone).toBe('needs-you');
    expect(line.text).toContain(shippedView.stageLabels.landgate ?? 'missing');
    expect(line.text).not.toContain('landgate');
  });

  test('a waiting item with a question in its read and no open ask reads Waiting', () => {
    const line = itemStateLine(shippedView, itemOn('a', 'landgate', 'waiting', true), null, false);
    expect(line.tone).toBe('quiet');
    expect(line.text).toContain(CHIP.waiting.label);
  });

  test('a running item with open asks needs you, as its stage counts it in "N need you"', () => {
    const line = itemStateLine(
      shippedView,
      itemOn('b', 'stage-build', 'running'),
      { stage: 'Build', step: 'Writes or fixes the change' },
      true
    );
    expect(line.tone).toBe('needs-you');
    expect(line.text).toContain(CHIP.needs_you.label);
  });

  test("an item at rest reads its outcome in the file's words", () => {
    const line = itemStateLine(shippedView, ended('triage', 'park'), null, false);
    expect(line.text).toContain(shippedView.outcomeLabels['triage:park'] ?? 'missing');
  });

  test("a done item whose outcome the file does not word takes the board's Done label", () => {
    // An outcome value the c1104737 graph does not declare, so the file cannot word it.
    const line = itemStateLine(shippedView, ended('land', 'stopped-by-hand'), null, false);
    expect(line.text).toContain(CHIP.done.label);
  });
});
