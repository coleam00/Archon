import { describe, test, expect } from 'bun:test';
import { pickActiveConversationId, type ConversationSummary } from './conversation';

function conv(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    title: null,
    platformType: 'web',
    lastActivityAt: null,
    ...over,
  };
}

describe('pickActiveConversationId', () => {
  test('an explicit deep-link id always wins, even one absent from the list', () => {
    // Worker conversations from chat-dispatched runs aren't in the project's
    // conversation list, but the messages API still accepts their platform id —
    // deep-linking must NOT silently fall back to the latest web conversation.
    const listed = [conv({ id: 'web-latest' })];
    expect(pickActiveConversationId(listed, 'cli-worker-conv')).toBe('cli-worker-conv');
  });

  test('without a deep link, falls back to the most-recent web conversation', () => {
    const listed = [
      conv({ id: 'cli-1', platformType: 'cli' }),
      conv({ id: 'web-2' }),
      conv({ id: 'web-1', lastActivityAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(pickActiveConversationId(listed, undefined)).toBe('web-2');
  });

  test('without a deep link and no web conversation, returns null until first send', () => {
    expect(pickActiveConversationId([conv({ id: 'cli-1', platformType: 'cli' })], undefined)).toBe(
      null
    );
  });

  test('tolerates an undefined conversation list (still loading) without a deep link', () => {
    expect(pickActiveConversationId(undefined, undefined)).toBe(null);
  });
});
