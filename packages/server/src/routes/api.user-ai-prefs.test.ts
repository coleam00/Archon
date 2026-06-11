import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must precede the dynamic import of ./api below. Exercises the
// per-user AI-preferences routes (GET/PATCH /api/auth/me/ai-prefs*).
// ---------------------------------------------------------------------------

const noopLogger = () => ({
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function (this: unknown) {
    return this;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
});

// --- Controllable web-auth module (../auth) ---
mock.module('../auth', () => ({
  getAuth: () => null,
  isWebAuthEnabled: () => false,
  getSignupMode: () => 'disabled',
  isApiGateEnabled: () => false,
}));

// --- Identity resolution (X-Archon-User → user) ---
const mockFindOrCreateUser = mock(async (_platform: string, platformUserId: string) => ({
  id: `user-from-${platformUserId}`,
  display_name: null,
  email: null,
  role: 'admin' as const,
  created_at: new Date(),
  updated_at: new Date(),
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

// --- In-memory per-user prefs store (the unit under test, via mocked core) ---
type Entry = { provider: string; model: string; effort?: string };
type Prefs = {
  tiers?: Record<string, Entry>;
  aliases?: Record<string, Entry>;
  defaultProvider?: string;
};
let prefsByUser: Record<string, Prefs> = {};

function applyPatch(
  current: Record<string, Entry>,
  patch: Record<string, Entry | null | undefined>
): Record<string, Entry> {
  const merged: Record<string, Entry> = {};
  for (const [k, v] of Object.entries(current)) {
    if (patch[k] !== null) merged[k] = v;
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && v !== undefined) merged[k] = v;
  }
  return merged;
}

const mockGetPrefs = mock(async (userId: string): Promise<Prefs> => prefsByUser[userId] ?? {});
const mockSetTiers = mock(async (userId: string, patch: Record<string, Entry | null>) => {
  const cur = prefsByUser[userId] ?? {};
  const tiers = applyPatch(cur.tiers ?? {}, patch);
  prefsByUser[userId] = {
    ...cur,
    ...(Object.keys(tiers).length ? { tiers } : { tiers: undefined }),
  };
});
const mockSetAliases = mock(async (userId: string, patch: Record<string, Entry | null>) => {
  const cur = prefsByUser[userId] ?? {};
  const aliases = applyPatch(cur.aliases ?? {}, patch);
  prefsByUser[userId] = {
    ...cur,
    ...(Object.keys(aliases).length ? { aliases } : { aliases: undefined }),
  };
});
const mockSetDefault = mock(async (userId: string, provider: string | null) => {
  const cur = prefsByUser[userId] ?? {};
  prefsByUser[userId] = { ...cur, defaultProvider: provider ?? undefined };
});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
  isPerUserProviderKeysEnabled: () => false,
  persistProviderApiKey: mock(async () => ({})),
  InvalidProviderKeyError: class InvalidProviderKeyError extends Error {},
  listUserProviderKeys: mock(async () => []),
  deleteUserProviderKey: mock(async () => {}),
  KNOWN_PROVIDERS: new Set<string>(['claude']),
  SUBSCRIPTION_PROVIDERS: new Set<string>(['claude']),
  startOAuth: mock(async () => ({})),
  pollOAuth: mock(() => ({ status: 'pending' })),
  // Per-user AI prefs surface under test:
  getUserAiPrefs: mockGetPrefs,
  setUserTiers: mockSetTiers,
  setUserAliases: mockSetAliases,
  setUserDefaultProvider: mockSetDefault,
}));

mock.module('@archon/paths', () => ({
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    `/tmp/.archon/workspaces/${owner}/${repo}/artifacts/runs/${runId}`,
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mock(async () => []),
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => ({ id: 'c', platform_conversation_id: 'web-x' })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({ id: 'm' })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';
import { isArchonOwnedAuthPath } from '../auth/config';
import { registerBuiltinProviders } from '@archon/providers';

// The route validates tier/alias providers against the real registry, which is
// empty until the server bootstrap registers built-ins — do it here (idempotent).
registerBuiltinProviders();

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

const ALICE = { 'X-Archon-User': 'alice' };
const JSON_HEADERS = { ...ALICE, 'Content-Type': 'application/json' };

beforeEach(() => {
  prefsByUser = {};
  mockGetPrefs.mockClear();
  mockSetTiers.mockClear();
  mockSetAliases.mockClear();
  mockSetDefault.mockClear();
});

describe('GET /api/auth/me/ai-prefs', () => {
  test('401 when no web identity resolves', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs');
    expect(res.status).toBe(401);
  });

  test('200 with empty prefs for a new user', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs', { headers: ALICE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(mockGetPrefs).toHaveBeenCalledWith('user-from-alice');
  });

  test('returns stored prefs', async () => {
    prefsByUser['user-from-alice'] = {
      tiers: { large: { provider: 'claude', model: 'opus' } },
      defaultProvider: 'codex',
    };
    const res = await makeApp().request('/api/auth/me/ai-prefs', { headers: ALICE });
    expect(await res.json()).toEqual({
      tiers: { large: { provider: 'claude', model: 'opus' } },
      defaultProvider: 'codex',
    });
  });

  test('path is exempt from the Better Auth catch-all', () => {
    expect(isArchonOwnedAuthPath('/api/auth/me/ai-prefs')).toBe(true);
    expect(isArchonOwnedAuthPath('/api/auth/me/ai-prefs/tiers')).toBe(true);
  });
});

describe('PATCH /api/auth/me/ai-prefs/tiers', () => {
  test('sets a tier and returns updated prefs', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/tiers', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tiers: { large: { provider: 'claude', model: 'opus' } } }),
    });
    expect(res.status).toBe(200);
    expect(mockSetTiers).toHaveBeenCalledWith('user-from-alice', {
      large: { provider: 'claude', model: 'opus' },
    });
    expect(await res.json()).toEqual({ tiers: { large: { provider: 'claude', model: 'opus' } } });
  });

  test('null unsets a tier', async () => {
    prefsByUser['user-from-alice'] = {
      tiers: {
        large: { provider: 'claude', model: 'opus' },
        small: { provider: 'claude', model: 'haiku' },
      },
    };
    const res = await makeApp().request('/api/auth/me/ai-prefs/tiers', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tiers: { large: null } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tiers: { small: { provider: 'claude', model: 'haiku' } } });
  });

  test('unknown provider → 400, nothing stored', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/tiers', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ tiers: { large: { provider: 'bogus', model: 'x' } } }),
    });
    expect(res.status).toBe(400);
    expect(mockSetTiers).not.toHaveBeenCalled();
  });

  test('invalid effort for provider → 400', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/tiers', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        tiers: { large: { provider: 'claude', model: 'opus', effort: 'ultra' } },
      }),
    });
    expect(res.status).toBe(400);
    expect(mockSetTiers).not.toHaveBeenCalled();
  });

  test('401 without identity', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/tiers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/auth/me/ai-prefs/aliases', () => {
  test('sets an @alias and returns updated prefs', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/aliases', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ aliases: { '@fast': { provider: 'claude', model: 'haiku' } } }),
    });
    expect(res.status).toBe(200);
    expect(mockSetAliases).toHaveBeenCalledWith('user-from-alice', {
      '@fast': { provider: 'claude', model: 'haiku' },
    });
  });

  test('reserved tier name as alias → 400', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/aliases', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ aliases: { large: { provider: 'claude', model: 'opus' } } }),
    });
    expect(res.status).toBe(400);
    expect(mockSetAliases).not.toHaveBeenCalled();
  });

  test('alias without @ prefix → 400', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/aliases', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ aliases: { fast: { provider: 'claude', model: 'haiku' } } }),
    });
    expect(res.status).toBe(400);
  });

  test('null unsets an alias', async () => {
    prefsByUser['user-from-alice'] = {
      aliases: { '@fast': { provider: 'claude', model: 'haiku' } },
    };
    const res = await makeApp().request('/api/auth/me/ai-prefs/aliases', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ aliases: { '@fast': null } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe('PATCH /api/auth/me/ai-prefs/default', () => {
  test('sets the default provider', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/default', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(200);
    expect(mockSetDefault).toHaveBeenCalledWith('user-from-alice', 'claude');
    expect(await res.json()).toEqual({ defaultProvider: 'claude' });
  });

  test('null clears the default', async () => {
    prefsByUser['user-from-alice'] = { defaultProvider: 'codex' };
    const res = await makeApp().request('/api/auth/me/ai-prefs/default', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: null }),
    });
    expect(res.status).toBe(200);
    expect(mockSetDefault).toHaveBeenCalledWith('user-from-alice', null);
  });

  test('unknown provider → 400', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/default', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: 'bogus' }),
    });
    expect(res.status).toBe(400);
    expect(mockSetDefault).not.toHaveBeenCalled();
  });

  test('401 without identity', async () => {
    const res = await makeApp().request('/api/auth/me/ai-prefs/default', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    });
    expect(res.status).toBe(401);
  });
});
