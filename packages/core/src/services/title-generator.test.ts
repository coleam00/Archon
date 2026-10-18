// @archon-test-isolated
import { mock, describe, test, expect, beforeEach, type Mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { captureStubLogOutput } from '@archon/paths/test-utils';
import type { MessageChunk, SendQueryOptions } from '@archon/providers/types';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// DB mock
const mockUpdateConversationTitle = mock(() => Promise.resolve()) as Mock<
  (id: string, title: string) => Promise<void>
>;

mock.module('../db/conversations', () => ({
  updateConversationTitle: mockUpdateConversationTitle,
}));

// AI client mock — sendQuery returns an AsyncGenerator<MessageChunk>
const mockSendQuery = mock(async function* (): AsyncGenerator<MessageChunk> {
  yield { type: 'agent_message_chunk', text: 'Summarize Project README' };
  yield { type: 'result' };
}) as Mock<
  (
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ) => AsyncGenerator<MessageChunk>
>;

const mockGetAgentProvider = mock(() => ({
  sendQuery: mockSendQuery,
  getType: () => 'claude',
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mockGetAgentProvider,
  getRegisteredProviders: mock(() => []),
  // credentials/delivery (#1955) imports these from '@archon/providers'.
  PI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

// ─── Import module under test (AFTER all mocks) ─────────────────────────────

import { generateAndSetTitle } from './title-generator';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('title-generator', () => {
  beforeEach(() => {
    mockUpdateConversationTitle.mockClear();
    mockSendQuery.mockClear();
    mockGetAgentProvider.mockClear();

    // Reset to default happy-path behavior
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'agent_message_chunk', text: 'Summarize Project README' };
      yield { type: 'result' };
    });

    mockGetAgentProvider.mockImplementation(() => ({
      sendQuery: mockSendQuery,
      getType: () => 'claude',
    }));

    mockUpdateConversationTitle.mockImplementation(() => Promise.resolve());

    // Clean env
    delete process.env.TITLE_GENERATION_MODEL;
  });

  test('happy path: generates and saves a clean title', async () => {
    await generateAndSetTitle('conv-1', 'Summarize the README of this project', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledTimes(1);
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-1', 'Summarize Project README');
  });

  test.each([
    ['"Summarize Project README"', 'Summarize Project README'],
    ['Title: Debug Auth Module', 'Debug Auth Module'],
    ['Fix Login Bug.', 'Fix Login Bug'],
    ['Fix Login Bug\nThis is an explanation', 'Fix Login Bug'],
  ])('cleans %j to %j', async (response, expectedTitle) => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'agent_message_chunk', text: response };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-clean', 'Fix the login bug', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-clean', expectedTitle);
  });

  test('handles empty AI response with fallback to truncated message', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-4', 'Help me debug this issue', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-4', 'Help me debug this issue');
  });

  test.each(['provider error', 'failed turn', 'generated title', 'empty title'] as const)(
    '%s never logs message contents',
    async scenario => {
      const userMessage =
        scenario === 'empty title' ? 'Title:' : 'PRIVATE_MESSAGE_4397 '.repeat(10);
      const expectedTitle =
        userMessage.length > 100 ? userMessage.slice(0, 97) + '...' : userMessage;
      mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
        if (scenario === 'provider error') throw new Error(`Provider rejected: ${userMessage}`);
        yield { type: 'agent_message_chunk', text: userMessage };
        yield {
          type: 'result',
          ...(scenario === 'failed turn'
            ? { failure: { class: 'transient' as const, evidence: userMessage } }
            : {}),
        };
      });

      const logOutput = captureStubLogOutput(mockLogger);
      try {
        await generateAndSetTitle('conv-private', userMessage, 'claude', '/tmp');
      } finally {
        logOutput.restore();
      }

      expect(mockUpdateConversationTitle).toHaveBeenCalledTimes(1);
      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-private', expectedTitle);
      const output = logOutput.output();
      expect(output).toContain('"conversationDbId":"conv-private"');
      if (scenario === 'provider error' || scenario === 'failed turn') {
        expect(output).toContain('"msg":"title.generate_failed"');
        expect(output).toContain('"msg":"title.fallback_set"');
      } else if (scenario === 'empty title') {
        expect(output).toContain('"msg":"title.generate_empty"');
      } else {
        expect(output).toContain('"msg":"title.generate_completed"');
      }
      expect(output).not.toContain(
        scenario === 'empty title' ? userMessage : 'PRIVATE_MESSAGE_4397'
      );
    }
  );

  test('a failed turn falls back instead of titling the conversation with partial text', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'agent_message_chunk', text: 'Partial Tit' };
      yield {
        type: 'result',
        isError: true,
        failure: { class: 'transient', evidence: 'Claude Code process exited with code 1' },
      };
    });

    await generateAndSetTitle('conv-5b', 'Fix the login bug', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledTimes(1);
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-5b', 'Fix the login bug');
  });

  test('includes workflow name in prompt when provided', async () => {
    await generateAndSetTitle('conv-6', 'Add dark mode', 'claude', '/tmp', 'archon-plan');

    // Verify the prompt passed to sendQuery includes the workflow name
    const promptArg = mockSendQuery.mock.calls[0][0] as string;
    expect(promptArg).toContain('Workflow: archon-plan');
  });

  test('does not include workflow context when workflowName not provided', async () => {
    await generateAndSetTitle('conv-7', 'Add dark mode', 'claude', '/tmp');

    const promptArg = mockSendQuery.mock.calls[0][0] as string;
    expect(promptArg).not.toContain('Workflow:');
  });

  test('truncates long AI-generated titles to MAX_TITLE_LENGTH', async () => {
    const longTitle = 'A'.repeat(150);
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'agent_message_chunk', text: longTitle };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-8', 'Some message', 'claude', '/tmp');

    const savedTitle = mockUpdateConversationTitle.mock.calls[0][1] as string;
    expect(savedTitle.length).toBeLessThanOrEqual(100);
    expect(savedTitle).toEndWith('...');
  });

  test('uses TITLE_GENERATION_MODEL env var when set', async () => {
    process.env.TITLE_GENERATION_MODEL = 'haiku';

    await generateAndSetTitle('conv-9', 'Some message', 'claude', '/tmp');

    // Verify model was passed in options
    const optionsArg = mockSendQuery.mock.calls[0][3] as { model?: string; tools?: string[] };
    expect(optionsArg.model).toBe('haiku');
  });

  test('passes undefined model when TITLE_GENERATION_MODEL not set', async () => {
    delete process.env.TITLE_GENERATION_MODEL;

    await generateAndSetTitle('conv-10', 'Some message', 'claude', '/tmp');

    const optionsArg = mockSendQuery.mock.calls[0][3] as { model?: string; tools?: string[] };
    expect(optionsArg.model).toBeUndefined();
  });

  test('marks title requests without inventing a workflow node', async () => {
    await generateAndSetTitle('conv-11', 'Some message', 'claude', '/tmp');

    const optionsArg = mockSendQuery.mock.calls[0][3];
    expect(optionsArg).toMatchObject({ purpose: 'title-generation' });
    expect(optionsArg?.nodeConfig?.nodeId).toBeUndefined();
    expect(optionsArg?.nodeConfig?.allowed_tools).toEqual([]);
  });

  test('passes assistantConfig through to the provider', async () => {
    const assistantConfig = { model: 'gpt-5.4', modelReasoningEffort: 'medium' };

    await generateAndSetTitle(
      'conv-12',
      'Some message',
      'codex',
      '/tmp',
      'figma-mcp-smoke',
      assistantConfig
    );

    const optionsArg = mockSendQuery.mock.calls[0][3] as {
      assistantConfig?: Record<string, unknown>;
    };
    expect(optionsArg.assistantConfig).toEqual(assistantConfig);
  });

  test('preserves resolved request options while marking title intent', async () => {
    await generateAndSetTitle('conv-13', 'Some message', 'claude', '/tmp', undefined, undefined, {
      model: 'haiku',
      assistantConfig: { settingSources: ['project'] },
      nodeConfig: { effort: 'high' },
      env: { CODEX_API_KEY: 'fixture-key' },
      protectedEnvKeys: ['CODEX_API_KEY'],
    });

    const optionsArg = mockSendQuery.mock.calls[0][3] as SendQueryOptions;
    expect(optionsArg).toMatchObject({ purpose: 'title-generation' });
    expect(optionsArg.env).toEqual({ CODEX_API_KEY: 'fixture-key' });
    expect(optionsArg.protectedEnvKeys).toEqual(['CODEX_API_KEY']);
    expect(optionsArg.model).toBe('haiku');
    expect(optionsArg.assistantConfig).toEqual({ settingSources: ['project'] });
    expect(optionsArg.nodeConfig).toEqual({
      effort: 'high',
      allowed_tools: [],
    });
  });

  test('handles double failure gracefully (AI fails + fallback DB write fails)', async () => {
    const userMessage = 'PRIVATE_DOUBLE_FAILURE_4397';
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      throw new Error(`AI failure: ${userMessage}`);
    });

    mockUpdateConversationTitle.mockImplementation(() =>
      Promise.reject(new Error(`DB write failure: ${userMessage}`))
    );

    const logOutput = captureStubLogOutput(mockLogger);
    try {
      await generateAndSetTitle('conv-12', userMessage, 'claude', '/tmp');
    } finally {
      logOutput.restore();
    }

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-12', userMessage);
    const output = logOutput.output();
    expect(output).toContain('"conversationDbId":"conv-12"');
    expect(output).toContain('"msg":"title.fallback_also_failed"');
    expect(output).not.toContain(userMessage);
  });

  test('collects text from multiple streaming chunks', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'agent_message_chunk', text: 'Debug ' };
      yield { type: 'agent_message_chunk', text: 'Auth ' };
      yield { type: 'agent_message_chunk', text: 'Module' };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-13', 'Debug the auth module', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-13', 'Debug Auth Module');
  });
});
