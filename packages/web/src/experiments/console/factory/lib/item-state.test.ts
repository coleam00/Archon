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
      null
    );
    expect(line.tone).toBe('merged');
    expect(line.text).toContain('Merged');
    expect(line.text).not.toContain('landed');
  });

  test("a running item reads the board card's running stage and step", () => {
    const line = itemStateLine(shippedView, itemOn('b', 'stage-build', 'running'), {
      stage: 'Build',
      step: 'Writes or fixes the change',
    });
    expect(line.tone).toBe('running');
    expect(line.text).toContain('Build');
    expect(line.text).toContain('Writes or fixes the change');
  });

  test("before the card's records answer, a running item names its stage by the file's label", () => {
    const line = itemStateLine(shippedView, itemOn('b', 'stage-build', 'running'), null);
    expect(line.tone).toBe('running');
    expect(line.text).toContain('Build');
    expect(line.text).not.toContain('stage-build');
  });

  test('an item waiting on an ask needs you, at its stage in the file’s words', () => {
    const line = itemStateLine(shippedView, itemOn('a', 'landgate', 'waiting', true), null);
    expect(line.tone).toBe('needs-you');
    expect(line.text).toContain(shippedView.stageLabels.landgate ?? 'missing');
    expect(line.text).not.toContain('landgate');
  });

  test("an item at rest reads its outcome in the file's words", () => {
    const line = itemStateLine(shippedView, ended('triage', 'park'), null);
    expect(line.text).toContain(shippedView.outcomeLabels['triage:park'] ?? 'missing');
  });

  test("a done item whose outcome the file does not word takes the board's Done label", () => {
    // An outcome value the b62ec7b graph does not declare, so the file cannot word it.
    const line = itemStateLine(shippedView, ended('land', 'stopped-by-hand'), null);
    expect(line.text).toContain(CHIP.done.label);
  });
});
