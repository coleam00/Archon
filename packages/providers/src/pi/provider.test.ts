import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock Pi AI SDK
const mockStreamSimple = mock();
const mockGetModel = mock();

mock.module('@mariozechner/pi-ai', () => ({
  streamSimple: mockStreamSimple,
  getModel: mockGetModel,
}));

import { PiProvider, parsePiModelString } from './provider';

/** Helper to create an async iterable from events */
function createEventStream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

const defaultUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
};

const mockModel = {
  id: 'gemini-2.5-pro',
  name: 'Gemini 2.5 Pro',
  api: 'google-generative-ai',
  provider: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 65536,
};

describe('PiProvider', () => {
  let provider: PiProvider;

  beforeEach(() => {
    provider = new PiProvider();
    mockStreamSimple.mockClear();
    mockGetModel.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();

    // Default mock: getModel returns a valid model
    mockGetModel.mockReturnValue(mockModel);
  });

  describe('getType', () => {
    test('returns pi', () => {
      expect(provider.getType()).toBe('pi');
    });
  });

  describe('getCapabilities', () => {
    test('returns all-false capability set', () => {
      const caps = provider.getCapabilities();
      expect(caps).toEqual({
        sessionResume: false,
        mcp: false,
        hooks: false,
        skills: false,
        toolRestrictions: false,
        structuredOutput: false,
        envInjection: false,
        costControl: false,
        effortControl: false,
        thinkingControl: false,
        fallbackModel: false,
        sandbox: false,
      });
    });
  });

  describe('parsePiModelString', () => {
    test('parses valid pi: model strings', () => {
      expect(parsePiModelString('pi:google/gemini-2.5-pro')).toEqual({
        provider: 'google',
        modelId: 'gemini-2.5-pro',
      });
      expect(parsePiModelString('pi:openai/gpt-4o')).toEqual({
        provider: 'openai',
        modelId: 'gpt-4o',
      });
      expect(parsePiModelString('pi:groq/llama-3.3-70b-versatile')).toEqual({
        provider: 'groq',
        modelId: 'llama-3.3-70b-versatile',
      });
    });

    test('returns undefined for non-pi strings', () => {
      expect(parsePiModelString('sonnet')).toBeUndefined();
      expect(parsePiModelString('claude-sonnet-4-20250514')).toBeUndefined();
      expect(parsePiModelString('gpt-4o')).toBeUndefined();
    });

    test('returns undefined for malformed pi: strings', () => {
      expect(parsePiModelString('pi:')).toBeUndefined();
      expect(parsePiModelString('pi:google')).toBeUndefined();
      expect(parsePiModelString('pi:google/')).toBeUndefined();
      expect(parsePiModelString('pi:/model')).toBeUndefined();
    });
  });

  describe('sendQuery', () => {
    test('streams text delta events as assistant chunks', async () => {
      const events = createEventStream([
        { type: 'start', partial: {} },
        { type: 'text_start', contentIndex: 0, partial: {} },
        { type: 'text_delta', contentIndex: 0, delta: 'Hello ', partial: {} },
        { type: 'text_delta', contentIndex: 0, delta: 'world!', partial: {} },
        { type: 'text_end', contentIndex: 0, content: 'Hello world!', partial: {} },
        {
          type: 'done',
          reason: 'stop',
          message: { usage: defaultUsage },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('test prompt', '/tmp', undefined, {
        model: 'pi:google/gemini-2.5-pro',
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { type: 'assistant', content: 'Hello ' },
        { type: 'assistant', content: 'world!' },
        {
          type: 'result',
          tokens: { input: 10, output: 5, total: 15, cost: 0.0015 },
          stopReason: 'stop',
          cost: 0.0015,
        },
      ]);
    });

    test('streams thinking events', async () => {
      const events = createEventStream([
        { type: 'thinking_start', contentIndex: 0, partial: {} },
        { type: 'thinking_delta', contentIndex: 0, delta: 'Let me think...', partial: {} },
        { type: 'thinking_end', contentIndex: 0, content: 'Let me think...', partial: {} },
        {
          type: 'done',
          reason: 'stop',
          message: { usage: defaultUsage },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
        model: 'pi:google/gemini-2.5-pro',
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({ type: 'thinking', content: 'Let me think...' });
    });

    test('streams tool call events', async () => {
      const toolCall = {
        type: 'toolCall' as const,
        id: 'call_123',
        name: 'read_file',
        arguments: { path: '/tmp/test.ts' },
      };
      const events = createEventStream([
        { type: 'toolcall_start', contentIndex: 0, partial: {} },
        { type: 'toolcall_delta', contentIndex: 0, delta: '{}', partial: {} },
        { type: 'toolcall_end', contentIndex: 0, toolCall, partial: {} },
        {
          type: 'done',
          reason: 'toolUse',
          message: { usage: defaultUsage },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
        model: 'pi:google/gemini-2.5-pro',
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'tool',
        toolName: 'read_file',
        toolInput: { path: '/tmp/test.ts' },
        toolCallId: 'call_123',
      });
    });

    test('handles error events', async () => {
      const events = createEventStream([
        {
          type: 'error',
          reason: 'error',
          error: {
            errorMessage: 'Rate limit exceeded',
            usage: defaultUsage,
          },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
        model: 'pi:google/gemini-2.5-pro',
      })) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: 'system',
        content: '❌ Pi error: Rate limit exceeded',
      });
      expect(chunks[1]).toMatchObject({
        type: 'result',
        isError: true,
        stopReason: 'error',
      });
    });

    test('throws on missing model', async () => {
      const gen = provider.sendQuery('test', '/tmp');
      await expect(gen.next()).rejects.toThrow('Pi provider requires a model');
    });

    test('throws on invalid model format', async () => {
      const gen = provider.sendQuery('test', '/tmp', undefined, {
        model: 'not-a-pi-model',
      });
      await expect(gen.next()).rejects.toThrow('Invalid Pi model format');
    });

    test('uses assistantConfig model as fallback', async () => {
      const events = createEventStream([
        {
          type: 'done',
          reason: 'stop',
          message: { usage: defaultUsage },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
        assistantConfig: { model: 'pi:google/gemini-2.5-pro' },
      })) {
        chunks.push(chunk);
      }

      expect(mockGetModel).toHaveBeenCalledWith('google', 'gemini-2.5-pro');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ type: 'result' });
    });

    test('passes systemPrompt to context', async () => {
      const events = createEventStream([
        {
          type: 'done',
          reason: 'stop',
          message: { usage: defaultUsage },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      for await (const _chunk of provider.sendQuery('test', '/tmp', undefined, {
        model: 'pi:google/gemini-2.5-pro',
        systemPrompt: 'You are a helpful assistant',
      })) {
        // consume
      }

      const callArgs = mockStreamSimple.mock.calls[0];
      expect(callArgs[1].systemPrompt).toBe('You are a helpful assistant');
    });

    test('ignores resumeSessionId (no session resume)', async () => {
      const events = createEventStream([
        {
          type: 'done',
          reason: 'stop',
          message: { usage: defaultUsage },
        },
      ]);
      mockStreamSimple.mockReturnValue(events);

      const chunks: unknown[] = [];
      for await (const chunk of provider.sendQuery('test', '/tmp', 'some-session-id', {
        model: 'pi:google/gemini-2.5-pro',
      })) {
        chunks.push(chunk);
      }

      // Should work fine, just ignoring the session ID
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ type: 'result' });
    });
  });
});
