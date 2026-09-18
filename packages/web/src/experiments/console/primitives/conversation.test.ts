import { describe, test, expect } from 'bun:test';
import {
  byMostRecent,
  conversationLabel,
  UNTITLED_CHAT,
  type ConversationSummary,
} from './conversation';

const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'web-1',
  title: 'Debug the migration',
  platformType: 'web',
  lastActivityAt: '2026-06-05T10:00:00Z',
  ...over,
});

describe('conversationLabel', () => {
  test('uses the title when there is one', () => {
    expect(conversationLabel(conv())).toBe('Debug the migration');
  });

  test('falls back for a chat the server has not titled yet', () => {
    // A brand-new chat has no title until the first message is summarised;
    // without the fallback the switcher renders a blank row.
    expect(conversationLabel(conv({ title: null }))).toBe(UNTITLED_CHAT);
    expect(conversationLabel(conv({ title: '' }))).toBe(UNTITLED_CHAT);
    expect(conversationLabel(conv({ title: '   ' }))).toBe(UNTITLED_CHAT);
  });
});

describe('byMostRecent', () => {
  const sorted = (cs: ConversationSummary[]): (string | null)[] =>
    [...cs].sort(byMostRecent).map(c => c.id);

  test('puts the most recently active first', () => {
    const older = conv({ id: 'older', lastActivityAt: '2026-06-01T10:00:00Z' });
    const newer = conv({ id: 'newer', lastActivityAt: '2026-06-09T10:00:00Z' });
    expect(sorted([older, newer])).toEqual(['newer', 'older']);
  });

  test('sorts a never-active chat last rather than first', () => {
    // A null date must not sort above real activity, or a stale empty chat
    // would open by default.
    const active = conv({ id: 'active', lastActivityAt: '2026-06-01T10:00:00Z' });
    const never = conv({ id: 'never', lastActivityAt: null });
    expect(sorted([never, active])).toEqual(['active', 'never']);
  });

  test('treats equal timestamps as equal', () => {
    expect(byMostRecent(conv({ id: 'a' }), conv({ id: 'b' }))).toBe(0);
  });
});
