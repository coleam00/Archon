import { describe, test, expect } from 'bun:test';
import { chooseOpenChat, lastChatKey } from './last-chat';

const list = (...ids: string[]) => ids.map(id => ({ id }));

describe('lastChatKey', () => {
  test('is scoped per project', () => {
    expect(lastChatKey('a')).not.toBe(lastChatKey('b'));
    expect(lastChatKey('a')).toStartWith('archon.console.');
  });
});

describe('chooseOpenChat', () => {
  test('reopens the remembered chat', () => {
    expect(chooseOpenChat('older', list('newest', 'older'))).toBe('older');
  });

  test('falls back to the most recent when nothing is remembered', () => {
    expect(chooseOpenChat(null, list('newest', 'older'))).toBe('newest');
  });

  test('a remembered chat that no longer exists does not win', () => {
    // Archived or deleted since — opening nothing would look like a broken page.
    expect(chooseOpenChat('gone', list('newest', 'older'))).toBe('newest');
  });

  test('an empty project opens nothing', () => {
    expect(chooseOpenChat('gone', [])).toBeNull();
    expect(chooseOpenChat(null, [])).toBeNull();
  });
});
