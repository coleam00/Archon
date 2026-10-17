// @archon-test-isolated
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

const mockFindConversationByPlatformId = mock(
  async (_platformId: string) =>
    null as null | {
      id: string;
      ai_assistant_type: string;
      platform_conversation_id: string;
      title: string | null;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

import { generateAndSetTitle } from '../../../core/src/services/title-generator';
import { generateTitleForUser } from '../../../core/src/services/user-title-generator';
import { resolveTitleRequest } from '../../../core/src/orchestrator/chat-request';
mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getBundledWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows'),
  ProjectRegistrationError: class ProjectRegistrationError extends Error {},
  inspectProjectBaseBranch: mock(async () => ({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  })),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  generateAndSetTitle,
  generateTitleForUser,
  resolveTitleRequest,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: () => ({
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
  }),
}));

mockAllWorkflowModules();

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  getConversationByPlatformId: (_platform: string, id: string) =>
    mockFindConversationByPlatformId(id),
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    ai_assistant_type: 'claude',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
  })),
}));

mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
const mockAddMessage = mock(async (_convId: string, _role: string, _content: string) => ({
  id: 'msg-uuid-1',
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
}));

mock.module('../../../core/src/config/config-loader', () => ({
  loadConfig: async () => ({ assistants: {}, tiers: {}, aliases: {} }),
}));
mock.module('../../../core/src/db/user-ai-prefs-store', () => ({
  getUserAiPrefs: async () => ({}),
}));
const listCredentials = mock(async (_userId: string) => []);
mock.module('../../../core/src/db/user-provider-key-store', () => ({
  listUserProviderKeys: listCredentials,
  getDecryptedProviderCredential: async () => ({ state: 'not_connected', source: 'archon' }),
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: async () => ({ id: 'requesting-user', role: 'member' }),
}));
const send = mock(async function* () {
  yield { type: 'agent_message_chunk', text: 'Title' };
});
mock.module('../../../core/src/services/provider-admission', () => ({
  getAgentProvider: () => ({ sendQuery: send }),
}));
import { registerInProcessProviders } from '@archon/providers/in-process';
registerInProcessProviders();
import { registerApiRoutes } from './api';
const previous = {
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
describe('Web title credential isolation', () => {
  test('skips a per-user title with no connection despite a host login', async () => {
    listCredentials.mockClear();
    process.env.GITHUB_APP_ID = '123';
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    process.env.ANTHROPIC_API_KEY = 'host-sentinel';
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(
      app,
      {
        setConversationDbId() {},
        emitLockEvent() {},
        async emitSSE() {},
      } as unknown as WebAdapter,
      {
        async acquireLock(_id: string, run: () => Promise<void>) {
          await run();
          return { status: 'started' };
        },
      } as unknown as ConversationLockManager
    );
    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Archon-User': 'requesting-user' },
      body: JSON.stringify({ message: 'Explain the project' }),
    });
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(send).not.toHaveBeenCalled();
    expect(listCredentials).toHaveBeenCalledWith('requesting-user');
  });
  test('workflow title skips absent credentials while dispatch still succeeds', async () => {
    listCredentials.mockClear();
    process.env.GITHUB_APP_ID = '123';
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    send.mockClear();
    mockFindConversationByPlatformId.mockResolvedValueOnce({
      id: 'workflow-conversation',
      ai_assistant_type: 'claude',
      platform_conversation_id: 'web-workflow',
      title: null,
      created_at: new Date(),
      updated_at: new Date(),
      platform_type: 'web',
      deleted_at: null,
      codebase_id: null,
    });
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(
      app,
      {
        setConversationDbId() {},
        emitLockEvent() {},
        async emitSSE() {},
      } as unknown as WebAdapter,
      {
        async acquireLock(_id: string, run: () => Promise<void>) {
          await run();
          return { status: 'started' };
        },
      } as unknown as ConversationLockManager
    );
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Archon-User': 'requesting-user' },
      body: JSON.stringify({ conversationId: 'web-workflow', message: 'Deploy the project' }),
    });
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(send).not.toHaveBeenCalled();
    expect(listCredentials).toHaveBeenCalledWith('requesting-user');
  });
});
