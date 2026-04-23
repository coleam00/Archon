import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths logger ───────────────────────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock @opencode-ai/sdk ───────────────────────────────────────────────

// Shared mutable state for test control
let mockSessionId = 'mock-session-id';
let mockEventSequence: Array<import('@opencode-ai/sdk').Event> = [];
let mockSessionList: Array<{ id: string }> = [];

const mockCreateSession = mock(async () => ({
  data: { id: mockSessionId },
}));

const mockSessionStatus = mock(async () => ({ data: { id: mockSessionId } }));

const mockPromptAsync = mock(async () => ({ data: { id: 'msg-123' } }));

const mockSessionAbort = mock(async () => ({}));

const mockEventSubscribe = mock(async () => ({
  stream: (async function* () {
    for (const ev of mockEventSequence) {
      yield ev;
    }
  })(),
}));

const mockClient = {
  session: {
    create: mockCreateSession,
    status: mockSessionStatus,
    promptAsync: mockPromptAsync,
    abort: mockSessionAbort,
    list: mock(async () => ({ data: mockSessionList })),
  },
  event: {
    subscribe: mockEventSubscribe,
  },
};

mock.module('@opencode-ai/sdk', () => ({
  createOpencodeClient: mock(() => mockClient),
}));

// ─── Mock server-manager ─────────────────────────────────────────────────
// Skip actual server lifecycle in tests

mock.module('./server-manager', () => ({
  ensureServer: mock(async () => ({
    hostname: '127.0.0.1',
    port: 4096,
    password: 'test-password',
  })),
  generatePassword: mock(() => 'test-password'),
}));

// ─── Import provider AFTER mocks are set up ──────────────────────────────

import { OpenCodeProvider } from './provider';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { registerOpencodeProvider } from './registration';
import {
  getRegistration,
  getProviderCapabilities,
  getProviderInfoList,
  getRegisteredProviders,
  isRegisteredProvider,
  clearRegistry,
  registerBuiltinProviders,
} from '../../registry';

describe('OpenCodeProvider', () => {
  beforeEach(() => {
    mockSessionId = 'mock-session-id';
    mockEventSequence = [];
    mockSessionList = [];
    mockCreateSession.mockClear();
    mockSessionStatus.mockClear();
    mockPromptAsync.mockClear();
    mockEventSubscribe.mockClear();
  });

  test('getType returns opencode', () => {
    const provider = new OpenCodeProvider();
    expect(provider.getType()).toBe('opencode');
  });

  test('getCapabilities returns OPENCODE_CAPABILITIES', () => {
    const provider = new OpenCodeProvider();
    expect(provider.getCapabilities()).toEqual(OPENCODE_CAPABILITIES);
  });

  test('sendQuery creates a new session and sends prompt', async () => {
    mockEventSequence = [
      {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'Hello' },
          delta: 'Hello',
        },
      } as import('@opencode-ai/sdk').Event,
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            sessionID: 's1',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'p0',
            modelID: 'claude-sonnet-4',
            providerID: 'anthropic',
            mode: 'chat',
            path: { cwd: '/tmp', root: '/tmp' },
            cost: 0.001,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const chunks: Array<import('../../types').MessageChunk> = [];

    for await (const chunk of provider.sendQuery('Test prompt', '/tmp/project')) {
      chunks.push(chunk);
    }

    expect(mockCreateSession).toHaveBeenCalled();
    expect(mockPromptAsync).toHaveBeenCalled();

    // Should yield assistant text chunk
    expect(chunks.some(c => c.type === 'assistant' && c.content === 'Hello')).toBe(true);
    // Should yield result chunk
    expect(chunks.some(c => c.type === 'result')).toBe(true);
  });

  test('sendQuery resumes existing session when resumeSessionId is provided', async () => {
    mockSessionList = [{ id: 'existing-session-id' }];
    mockEventSequence = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            sessionID: 'existing-session-id',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'p0',
            modelID: 'claude-sonnet-4',
            providerID: 'anthropic',
            mode: 'chat',
            path: { cwd: '/tmp', root: '/tmp' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const chunks: Array<import('../../types').MessageChunk> = [];

    for await (const chunk of provider.sendQuery('Test', '/tmp', 'existing-session-id')) {
      chunks.push(chunk);
    }

    expect(mockSessionStatus).toHaveBeenCalledWith({ path: { id: 'existing-session-id' } });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test('sendQuery falls back to new session when resumeSessionId is invalid', async () => {
    mockSessionStatus.mockImplementationOnce(async () => {
      throw new Error('Session not found');
    });

    mockEventSequence = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            sessionID: 'new-session-id',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'p0',
            modelID: 'claude-sonnet-4',
            providerID: 'anthropic',
            mode: 'chat',
            path: { cwd: '/tmp', root: '/tmp' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const chunks: Array<import('../../types').MessageChunk> = [];

    for await (const chunk of provider.sendQuery('Test', '/tmp', 'invalid-id')) {
      chunks.push(chunk);
    }

    expect(mockSessionStatus).toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalled();
    // Should yield a system warning about resume failure
    expect(chunks.some(c => c.type === 'system')).toBe(true);
  });

  test('sendQuery yields thinking chunks for reasoning parts', async () => {
    mockEventSequence = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'reasoning',
            text: 'Let me think...',
          },
          delta: 'Let me think...',
        },
      } as import('@opencode-ai/sdk').Event,
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            sessionID: 's1',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'p0',
            modelID: 'claude-sonnet-4',
            providerID: 'anthropic',
            mode: 'chat',
            path: { cwd: '/tmp', root: '/tmp' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const chunks: Array<import('../../types').MessageChunk> = [];

    for await (const chunk of provider.sendQuery('Test', '/tmp')) {
      chunks.push(chunk);
    }

    expect(chunks.some(c => c.type === 'thinking' && c.content === 'Let me think...')).toBe(true);
  });

  test('sendQuery handles tool calls', async () => {
    mockEventSequence = [
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'tool',
            callID: 'call-1',
            tool: 'read',
            state: { status: 'pending', input: { path: '/tmp/file.txt' }, raw: '' },
          },
          delta: undefined,
        },
      } as import('@opencode-ai/sdk').Event,
      {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p2',
            sessionID: 's1',
            messageID: 'm1',
            type: 'tool',
            callID: 'call-1',
            tool: 'read',
            state: {
              status: 'completed',
              input: { path: '/tmp/file.txt' },
              output: { content: 'hello' },
              raw: '',
            },
          },
          delta: undefined,
        },
      } as import('@opencode-ai/sdk').Event,
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            sessionID: 's1',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'p0',
            modelID: 'claude-sonnet-4',
            providerID: 'anthropic',
            mode: 'chat',
            path: { cwd: '/tmp', root: '/tmp' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const chunks: Array<import('../../types').MessageChunk> = [];

    for await (const chunk of provider.sendQuery('Read file', '/tmp')) {
      chunks.push(chunk);
    }

    const toolChunk = chunks.find(c => c.type === 'tool');
    expect(toolChunk).toBeDefined();
    expect(toolChunk?.type === 'tool' && toolChunk.toolName).toBe('read');

    const toolResultChunk = chunks.find(c => c.type === 'tool_result');
    expect(toolResultChunk).toBeDefined();
  });

  test('sendQuery handles session errors', async () => {
    mockEventSequence = [
      {
        type: 'session.error',
        properties: {
          sessionID: 's1',
          error: {
            name: 'ApiError',
            data: { message: 'Rate limit exceeded', statusCode: 429, isRetryable: true },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const chunks: Array<import('../../types').MessageChunk> = [];

    for await (const chunk of provider.sendQuery('Test', '/tmp')) {
      chunks.push(chunk);
    }

    const resultChunk = chunks.find(c => c.type === 'result');
    expect(resultChunk).toBeDefined();
    expect(resultChunk?.type === 'result' && resultChunk.isError).toBe(true);
  });

  test('sendQuery passes model config to prompt', async () => {
    mockEventSequence = [
      {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            sessionID: 's1',
            role: 'assistant',
            time: { created: 1 },
            parentID: 'p0',
            modelID: 'gpt-5',
            providerID: 'openai',
            mode: 'chat',
            path: { cwd: '/tmp', root: '/tmp' },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
      } as import('@opencode-ai/sdk').Event,
    ];

    const provider = new OpenCodeProvider();
    const gen = provider.sendQuery('Test', '/tmp', undefined, {
      model: 'openai/gpt-5',
      systemPrompt: 'You are a helpful assistant',
      nodeConfig: { allowed_tools: ['read', 'bash'] },
    });

    // Consume all chunks
    for await (const _ of gen) {
      // no-op
    }

    const promptCall = mockPromptAsync.mock.calls[0];
    expect(promptCall).toBeDefined();
    const body = promptCall[0].body;
    expect(body.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(body.system).toBe('You are a helpful assistant');
    expect(body.tools).toEqual({ read: true, bash: true });
  });
});

describe('registerOpencodeProvider', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
  });

  test('registers opencode with builtIn: false', () => {
    registerOpencodeProvider();
    const reg = getRegistration('opencode');
    expect(reg.id).toBe('opencode');
    expect(reg.displayName).toBe('OpenCode (community)');
    expect(reg.builtIn).toBe(false);
  });

  test('is idempotent', () => {
    registerOpencodeProvider();
    expect(() => registerOpencodeProvider()).not.toThrow();
    const entries = getRegistration('opencode');
    expect(entries).toBeDefined();
  });

  test('declares expected capabilities', () => {
    registerOpencodeProvider();
    const caps = getProviderCapabilities('opencode');
    expect(caps.sessionResume).toBe(true);
    expect(caps.mcp).toBe(true);
    expect(caps.structuredOutput).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.skills).toBe(true);
    expect(caps.hooks).toBe(false);
    expect(caps.agents).toBe(false);
    expect(caps.costControl).toBe(false);
    expect(caps.sandbox).toBe(false);
  });

  test('isModelCompatible accepts provider/model refs', () => {
    registerOpencodeProvider();
    const reg = getRegistration('opencode');
    expect(reg.isModelCompatible('anthropic/claude-sonnet-4')).toBe(true);
    expect(reg.isModelCompatible('openai/gpt-5')).toBe(true);
    expect(reg.isModelCompatible('google/gemini-2.5-pro')).toBe(true);
    expect(reg.isModelCompatible('claude-3.5-sonnet')).toBe(true);
    expect(reg.isModelCompatible('')).toBe(false);
  });

  test('appears in getProviderInfoList with builtIn: false', () => {
    registerOpencodeProvider();
    const info = getProviderInfoList().find(p => p.id === 'opencode');
    expect(info).toBeDefined();
    expect(info?.builtIn).toBe(false);
  });

  test('does not collide with built-ins', () => {
    registerOpencodeProvider();
    const ids = getRegisteredProviders()
      .map(p => p.id)
      .sort();
    expect(ids).toEqual(['claude', 'codex', 'opencode']);
  });
});
