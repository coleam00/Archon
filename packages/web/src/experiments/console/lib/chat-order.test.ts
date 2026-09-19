import { describe, test, expect } from 'bun:test';
import { applyChatOrder, chatOrderKey, readChatOrder, reorder } from './chat-order';

const list = (...ids: string[]) => ids.map(id => ({ id }));
const ids = (items: { id: string }[]) => items.map(i => i.id);

describe('chatOrderKey', () => {
  test('is scoped per project and namespaced', () => {
    expect(chatOrderKey('a')).not.toBe(chatOrderKey('b'));
    expect(chatOrderKey('a')).toStartWith('archon.console.');
  });
});

describe('applyChatOrder', () => {
  test('puts ordered chats first, in the order given', () => {
    expect(ids(applyChatOrder(list('a', 'b', 'c'), ['c', 'a']))).toEqual(['c', 'a', 'b']);
  });

  test('a chat created since keeps its recency place behind the order', () => {
    // Otherwise a new chat would be buried by an order that predates it.
    expect(ids(applyChatOrder(list('new', 'a', 'b'), ['b', 'a']))).toEqual(['b', 'a', 'new']);
  });

  test('ids in the order that no longer exist are ignored', () => {
    expect(ids(applyChatOrder(list('a', 'b'), ['gone', 'b']))).toEqual(['b', 'a']);
  });

  test('no order leaves recency untouched', () => {
    expect(ids(applyChatOrder(list('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c']);
  });
});

describe('reorder', () => {
  test('moves the dragged chat to the target position', () => {
    expect(reorder(list('a', 'b', 'c'), 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorder(list('a', 'b', 'c'), 'a', 'c')).toEqual(['b', 'c', 'a']);
  });

  test('dropping a chat on itself changes nothing', () => {
    expect(reorder(list('a', 'b'), 'a', 'a')).toEqual(['a', 'b']);
  });

  test('an unknown id is a no-op rather than a corrupted order', () => {
    expect(reorder(list('a', 'b'), 'ghost', 'a')).toEqual(['a', 'b']);
  });
});

describe('readChatOrder', () => {
  test('a non-array or malformed value reads as no order', () => {
    // A hand-edited value must not take the rail down.
    expect(readChatOrder('never-written-to')).toEqual([]);
  });
});
