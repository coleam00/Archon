import { describe, expect, test } from 'bun:test';
import { NO_ITEM_ASKS } from '../../components/ItemAsksSection';
import type { RunsAttention } from '../../primitives/run';
import { askOn, asksOn, itemOn } from '../items.test-fixtures';
import { askedOf, askReadOf } from './item-asks';

const read = itemOn('a', 'stage-build', 'waiting');
const attention = {} as RunsAttention;

describe("an item's asks", () => {
  test('are not known while the attention list is read, or when it never answered', () => {
    expect(askReadOf(undefined, undefined, NO_ITEM_ASKS)).toBe('reading');
    expect(askReadOf(undefined, new Error('down'), NO_ITEM_ASKS)).toBe('failed');
    expect(askedOf('reading', read)).toBeNull();
    expect(askedOf('failed', read)).toBeNull();
    expect(askedOf(null, read)).toBeNull();
  });

  test('a failed read again keeps the asks read before, rather than blanking every button', () => {
    const asks = asksOn([read]);
    expect(askReadOf(attention, new Error('down'), asks)).toBe(asks);
    expect(askedOf(asks, read)).toBe(true);
  });

  test('an ask answered here this session no longer counts', () => {
    const ask = askOn(read);
    const answered = { ...asksOn([read]), answered: [{ ask }] } as unknown as typeof NO_ITEM_ASKS;
    expect(askedOf(answered, read)).toBe(false);
  });
});
