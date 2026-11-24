import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PlacedCard } from './board';
import { boardModel } from './board';
import { FIXTURE_NOW, progressOf, realItem, VIEW } from './board.test-fixtures';
import { earlierSearch, mergedWindow } from './merged-window';

/** Real item 7 (merged) keyed `key`, merged at `at` (a local time); null for no merge time. */
function mergedAt(key: string, at: Date | null): PlacedCard {
  const item = realItem('7');
  const progress = progressOf(item);
  if (progress.change === null) throw new Error('item 7 has a change');
  item.item = { ...item.item, key };
  item.progress = {
    ...progress,
    change: { ...progress.change, mergedAt: at === null ? null : at.toISOString() },
  };
  const placed = boardModel(VIEW, 'cb-1', [item], new Map(), FIXTURE_NOW).columns.flatMap(
    c => c.cards
  )[0];
  if (placed === undefined) throw new Error('the merged item has no card');
  return placed;
}

// The window counts local calendar days, so run it in a zone that is not UTC: a window
// counted from UTC midnight passes in UTC. Every date is built after the zone is set, in local
// time, as the window is. Restoring needs 'UTC': an unset TZ does not restore it in bun test.
let NOW = new Date(0);
beforeAll(() => {
  process.env.TZ = 'America/Chicago';
  NOW = new Date(2026, 10, 18, 10, 0);
});
afterAll(() => {
  process.env.TZ = 'UTC';
});
const keys = (cards: readonly PlacedCard[]): string[] => cards.map(placed => placed.card.key);

describe('the Merged column window', () => {
  test('6 days ago is in, 8 days ago is out', () => {
    const window = mergedWindow(
      [mergedAt('six', new Date(2026, 10, 12, 9, 0)), mergedAt('eight', new Date(2026, 10, 10))],
      NOW
    );
    expect(keys(window.recent)).toEqual(['six']);
    expect(window.earlier).toBe(1);
  });

  test('the window starts at local midnight 6 days back: on it is in, a moment before is out', () => {
    const midnight = new Date(2026, 10, 12, 0, 0, 0, 0);
    const window = mergedWindow(
      [mergedAt('on', midnight), mergedAt('before', new Date(midnight.getTime() - 1))],
      NOW
    );
    expect(keys(window.recent)).toEqual(['on']);
    expect(window.earlier).toBe(1);
  });

  test('newest first; a card with no merge time counts as earlier', () => {
    const window = mergedWindow(
      [
        mergedAt('monday', new Date(2026, 10, 16, 8)),
        mergedAt('unknown', null),
        mergedAt('today', new Date(2026, 10, 18, 9)),
        mergedAt('tuesday', new Date(2026, 10, 17, 23)),
      ],
      NOW
    );
    expect(keys(window.recent)).toEqual(['today', 'tuesday', 'monday']);
    expect(window.earlier).toBe(1);
  });

  test('"N earlier" opens the Table filtered to merged, keeping a lit work order', () => {
    expect(earlierSearch(new URLSearchParams())).toBe('?view=table&show=landed');
    expect(earlierSearch(new URLSearchParams('order=48&show=in-flight'))).toBe(
      '?view=table&show=landed&order=48'
    );
  });
});
