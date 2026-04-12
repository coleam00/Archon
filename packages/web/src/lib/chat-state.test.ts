import { describe, expect, test } from 'bun:test';
import { getEffectiveProjectId, resolveCurrentConversation } from './chat-state';
import type { CodebaseResponse, ConversationResponse } from './api';

function makeCodebase(id: string): CodebaseResponse {
  return {
    id,
    name: `codebase-${id}`,
    repository_url: null,
    default_cwd: '/repo',
    ai_assistant_type: 'codex',
    allow_env_keys: false,
    commands: {},
    created_at: '2026-04-12T00:00:00Z',
    updated_at: '2026-04-12T00:00:00Z',
  };
}

function makeConversation(
  platformConversationId: string,
  overrides?: Partial<ConversationResponse>
): ConversationResponse {
  return {
    id: `db-${platformConversationId}`,
    platform_type: 'web',
    platform_conversation_id: platformConversationId,
    codebase_id: null,
    cwd: null,
    ai_assistant_type: 'codex',
    title: null,
    last_activity_at: null,
    created_at: '2026-04-12T00:00:00Z',
    updated_at: '2026-04-12T00:00:00Z',
    ...overrides,
  };
}

describe('getEffectiveProjectId', () => {
  test('returns undefined when no project is selected', () => {
    expect(getEffectiveProjectId(null, [makeCodebase('a')])).toBeUndefined();
  });

  test('returns undefined when the selected project is stale', () => {
    expect(getEffectiveProjectId('missing', [makeCodebase('a')])).toBeUndefined();
  });

  test('returns the selected project id when it exists in the current codebase list', () => {
    expect(getEffectiveProjectId('a', [makeCodebase('a'), makeCodebase('b')])).toBe('a');
  });
});

describe('resolveCurrentConversation', () => {
  test('prefers the direct route conversation payload when available', () => {
    const routeConversation = makeConversation('web-1', { title: 'Route copy' });
    const sidebarConversation = makeConversation('web-1', { title: 'Sidebar copy' });

    expect(resolveCurrentConversation('web-1', routeConversation, [sidebarConversation])).toEqual(
      routeConversation
    );
  });

  test('falls back to the sidebar conversation list when the direct lookup is unavailable', () => {
    const sidebarConversation = makeConversation('web-2', { title: 'Sidebar copy' });

    expect(resolveCurrentConversation('web-2', undefined, [sidebarConversation])).toEqual(
      sidebarConversation
    );
  });

  test('returns undefined when neither source contains the active conversation', () => {
    expect(
      resolveCurrentConversation('web-3', undefined, [makeConversation('web-2')])
    ).toBeUndefined();
  });
});
