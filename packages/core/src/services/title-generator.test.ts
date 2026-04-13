import { mock, describe, test, expect, beforeEach, type Mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { MessageChunk } from '../types';

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
  yield { type: 'assistant', content: 'Summarize Project README' };
  yield { type: 'result' };
}) as Mock<
  (
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: { model?: string; tools?: string[] }
  ) => AsyncGenerator<MessageChunk>
>;

const mockGetAgentProvider = mock(() => ({
  sendQuery: mockSendQuery,
  getType: () => 'claude',
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mockGetAgentProvider,
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
      yield { type: 'assistant', content: 'Summarize Project README' };
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

  test('strips surrounding quotes from AI response', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: '"Summarize Project README"' };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-2', 'Summarize the README', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-2', 'Summarize Project README');
  });

  test('strips "Title: " prefix from AI response', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'Title: Debug Auth Module' };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-3', 'Debug the auth module', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-3', 'Debug Auth Module');
  });

  test('handles empty AI response with fallback to truncated message', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-4', 'Help me debug this issue', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-4', 'Help me debug this issue');
  });

  test('handles AI client error with fallback to truncated message', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      throw new Error('API key not set');
    });

    await generateAndSetTitle('conv-5', 'Fix the login bug', 'claude', '/tmp');

    // Should not throw — fire-and-forget safe
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-5', 'Fix the login bug');
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
      yield { type: 'assistant', content: longTitle };
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

  test('passes nodeConfig with allowed_tools: [] to disable tool access', async () => {
    await generateAndSetTitle('conv-11', 'Some message', 'claude', '/tmp');

    const optionsArg = mockSendQuery.mock.calls[0][3] as {
      model?: string;
      nodeConfig?: { allowed_tools?: string[] };
    };
    expect(optionsArg.nodeConfig?.allowed_tools).toEqual([]);
  });

  test('handles double failure gracefully (AI fails + fallback DB write fails)', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      throw new Error('AI failure');
    });

    mockUpdateConversationTitle.mockImplementation(() =>
      Promise.reject(new Error('DB write failure'))
    );

    // Should NOT throw despite both failures
    await generateAndSetTitle('conv-12', 'Some message', 'claude', '/tmp');

    // Verify it attempted the fallback write
    expect(mockUpdateConversationTitle).toHaveBeenCalled();
  });

  test('collects text from multiple streaming chunks', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'Debug ' };
      yield { type: 'assistant', content: 'Auth ' };
      yield { type: 'assistant', content: 'Module' };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-13', 'Debug the auth module', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-13', 'Debug Auth Module');
  });

  test('strips trailing punctuation from title', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'Fix Login Bug.' };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-14', 'Fix the login bug', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-14', 'Fix Login Bug');
  });

  test('takes only first line of multi-line response', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'Fix Login Bug\nThis is an explanation' };
      yield { type: 'result' };
    });

    await generateAndSetTitle('conv-15', 'Fix the login bug', 'claude', '/tmp');

    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('conv-15', 'Fix Login Bug');
  });

  test('long user message is truncated in fallback', async () => {
    mockSendQuery.mockImplementation(async function* (): AsyncGenerator<MessageChunk> {
      throw new Error('AI failure');
    });

    const longMessage = 'A'.repeat(200);

    await generateAndSetTitle('conv-16', longMessage, 'claude', '/tmp');

    const savedTitle = mockUpdateConversationTitle.mock.calls[0][1] as string;
    expect(savedTitle.length).toBeLessThanOrEqual(100);
    expect(savedTitle).toEndWith('...');
  });
});
