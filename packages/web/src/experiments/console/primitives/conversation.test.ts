import { describe, test, expect } from 'bun:test';
import {
  byMostRecent,
  colorToken,
  conversationLabel,
  conversationMonogram,
  matchesFilter,
  parseConversationColor,
  UNTITLED_CHAT,
  type ConversationSummary,
} from './conversation';

const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 'web-1',
  title: 'Debug the migration',
  platformType: 'web',
  lastActivityAt: '2026-06-05T10:00:00Z',
  color: null,
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

describe('parseConversationColor', () => {
  test('accepts every color in the palette', () => {
    expect(parseConversationColor('magenta')).toBe('magenta');
    expect(parseConversationColor('teal')).toBe('teal');
    expect(parseConversationColor('red')).toBe('red');
  });

  test('no color is the default', () => {
    expect(parseConversationColor(null)).toBeNull();
    expect(parseConversationColor(undefined)).toBeNull();
  });

  test('an unrecognised value reads as no color rather than a blank swatch', () => {
    // A value written by a newer build, or hand-edited, must not render an
    // empty circle or reach the style attribute.
    expect(parseConversationColor('chartreuse')).toBeNull();
    expect(parseConversationColor('')).toBeNull();
    expect(parseConversationColor('MAGENTA')).toBeNull();
  });
});

describe('colorToken', () => {
  test('maps a color to a design token, never a raw hex', () => {
    expect(colorToken('magenta')).toBe('var(--brand-magenta)');
    expect(colorToken('green')).toBe('var(--success)');
  });

  test('no color maps to no token', () => {
    expect(colorToken(null)).toBeNull();
  });
});

describe('conversationMonogram', () => {
  test('uses the initials of the first two words', () => {
    expect(conversationMonogram(conv({ title: 'Debug the migration' }))).toBe('DT');
    expect(conversationMonogram(conv({ title: 'Console chat rail' }))).toBe('CC');
  });

  test('uses the first two letters of a single word', () => {
    expect(conversationMonogram(conv({ title: 'Migration' }))).toBe('MI');
  });

  test('an untitled chat still gets a tile', () => {
    // A blank tile reads as a loading state that never resolves.
    // "Untitled chat" is two words, so it takes their initials like any other.
    expect(conversationMonogram(conv({ title: null }))).toBe('UC');
  });

  test('falls back rather than rendering an empty tile', () => {
    expect(conversationMonogram(conv({ title: '!!! ???' }))).toBe('??');
  });
});

describe('matchesFilter', () => {
  test('matches on any part of the title, ignoring case', () => {
    const c = conv({ title: 'Debug the migration' });
    expect(matchesFilter(c, 'migration')).toBe(true);
    expect(matchesFilter(c, 'MIGRA')).toBe(true);
    expect(matchesFilter(c, 'debug')).toBe(true);
  });

  test('an empty query matches everything, so clearing the box restores the list', () => {
    expect(matchesFilter(conv(), '')).toBe(true);
    expect(matchesFilter(conv(), '   ')).toBe(true);
  });

  test('a non-match is excluded', () => {
    expect(matchesFilter(conv({ title: 'Debug the migration' }), 'deploy')).toBe(false);
  });

  test('an untitled chat is findable by its fallback label', () => {
    expect(matchesFilter(conv({ title: null }), 'untitled')).toBe(true);
  });
});
