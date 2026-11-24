import { describe, expect, test } from 'bun:test';
import type { FactoryItem } from '../../skills/factory';
import { capturedItemAs, capturedItemsPage } from './fixtures/factory-items-page';
import { closestItems, ITEM_SEARCH_LIMIT } from './item-search';

/** A captured item under `key`, titled `title`, or with no progress when `title` is null. */
function item(key: string, title: string | null): FactoryItem {
  const base = capturedItemAs(key, null);
  const progress = capturedItemsPage.items.find(entry => entry.progress !== null)?.progress;
  if (title === null || progress == null) return base;
  return { ...base, progress: { ...progress, title } };
}

const keys = (found: FactoryItem[]): string[] => found.map(entry => entry.item.key);

describe('closestItems', () => {
  test('an empty or blank query lists nothing', () => {
    expect(closestItems(capturedItemsPage.items, '')).toEqual([]);
    expect(closestItems(capturedItemsPage.items, '   ')).toEqual([]);
  });

  test('ranks the key itself, then keys starting with it, then keys holding it, then titles', () => {
    const items = [
      item('130', 'Unrelated'),
      item('Fix 13', 'Unrelated'),
      item('7', 'Item 13 follow-up'),
      item('13', 'The one asked for'),
      item('99', 'Unrelated'),
    ];
    expect(keys(closestItems(items, '13'))).toEqual(['13', '130', 'Fix 13', '7']);
  });

  test('matches regardless of case, and trims the query', () => {
    const items = [item('ABC-1', 'Board polish'), item('2', 'Add a BOARD filter')];
    expect(keys(closestItems(items, '  abc-1 '))).toEqual(['ABC-1']);
    expect(keys(closestItems(items, 'board'))).toEqual(['ABC-1', '2']);
  });

  test('an item with no progress is titled by its key', () => {
    expect(keys(closestItems([item('needle', null)], 'eed'))).toEqual(['needle']);
  });

  test('keeps the input order within a rank, and lists at most the limit', () => {
    const items = Array.from({ length: 12 }, (_, index) => item(`1${index.toString()}`, 'x'));
    const found = closestItems(items, '1');
    expect(found).toHaveLength(ITEM_SEARCH_LIMIT);
    expect(keys(found)).toEqual(items.slice(0, ITEM_SEARCH_LIMIT).map(entry => entry.item.key));
    expect(closestItems(items, '1', 3)).toHaveLength(3);
  });
});
