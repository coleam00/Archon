import { describe, test, expect } from 'bun:test';
import {
  toConversationSummary,
  isBriefStale,
  BRIEF_STALE_AFTER_MS,
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
  dbId: 'db-1',
  title: 'Debug the migration',
  platformType: 'web',
  lastActivityAt: '2026-06-05T10:00:00Z',
  color: null,
  brief: null,
  briefUpdatedAt: null,
  briefPinned: false,
  archived: false,
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
    expect(parseConversationColor('blue')).toBe('blue');
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
    expect(colorToken('blue')).toBe('var(--brand-blue)');
    expect(colorToken('green')).toBe('var(--brand-green)');
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

describe('toConversationSummary — archived', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: 'db-1',
    platform_conversation_id: 'web-1',
    platform_type: 'web',
    title: 'Refund reconciliation',
    last_activity_at: '2026-06-05T10:00:00Z',
    color: null,
    brief: null,
    brief_updated_at: null,
    brief_pinned: false,
    ...over,
  });

  test('a soft-deleted conversation reads as archived', () => {
    expect(toConversationSummary(raw({ deleted_at: '2026-06-06T10:00:00Z' })).archived).toBe(true);
  });

  test('a live conversation is not archived', () => {
    expect(toConversationSummary(raw({ deleted_at: null })).archived).toBe(false);
    // Older payloads omit the field entirely rather than sending null.
    expect(toConversationSummary(raw()).archived).toBe(false);
  });
});

describe('isBriefStale', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  const withBrief = (brief: string | null, updated: string | null) =>
    conv({ brief, briefUpdatedAt: updated });

  test('a summary written just now is current', () => {
    expect(isBriefStale(withBrief('Fixing the refund job.', '2026-06-10T11:00:00Z'), now)).toBe(
      false
    );
  });

  test('a summary older than the window is stale', () => {
    expect(isBriefStale(withBrief('Fixing the refund job.', '2026-06-08T12:00:00Z'), now)).toBe(
      true
    );
  });

  test('the boundary is not stale, one millisecond past it is', () => {
    const edge = new Date(now - BRIEF_STALE_AFTER_MS).toISOString();
    const past = new Date(now - BRIEF_STALE_AFTER_MS - 1).toISOString();
    expect(isBriefStale(withBrief('x', edge), now)).toBe(false);
    expect(isBriefStale(withBrief('x', past), now)).toBe(true);
  });

  test('no summary is absent, not stale', () => {
    // An empty card must not shout a warning about text that was never written.
    expect(isBriefStale(withBrief(null, null), now)).toBe(false);
    expect(isBriefStale(withBrief(null, '2026-01-01T00:00:00Z'), now)).toBe(false);
  });

  test('an unparsable timestamp is treated as current rather than crying wolf', () => {
    expect(isBriefStale(withBrief('x', 'not-a-date'), now)).toBe(false);
  });
});

describe('toConversationSummary — summary fields', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'db-1',
    platform_conversation_id: 'web-1',
    platform_type: 'web',
    title: 'Refund reconciliation',
    last_activity_at: '2026-06-05T10:00:00Z',
    color: null,
    ...over,
  });

  test('carries the summary the server stored', () => {
    const c = toConversationSummary(
      row({ brief: 'Half done.', brief_updated_at: '2026-06-05T10:00:00Z', brief_pinned: true })
    );
    expect(c.brief).toBe('Half done.');
    expect(c.briefUpdatedAt).toBe('2026-06-05T10:00:00Z');
    expect(c.briefPinned).toBe(true);
  });

  test('a blank summary reads as none, so the card stays clean', () => {
    expect(toConversationSummary(row({ brief: '   ' })).brief).toBeNull();
    expect(toConversationSummary(row({ brief: null })).brief).toBeNull();
    expect(toConversationSummary(row()).brief).toBeNull();
  });

  test('an older payload without the fields does not claim a pin', () => {
    expect(toConversationSummary(row()).briefPinned).toBe(false);
  });
});
