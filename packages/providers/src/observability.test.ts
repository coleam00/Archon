import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  withObservabilityContext,
  getObservabilityContext,
  isLangfuseEnabled,
  initLangfuse,
  shutdownLangfuse,
  traceQuery,
} from './observability';
import type { MessageChunk } from './types';

describe('observability', () => {
  // ─── Context Propagation ────────────────────────────────────────────────

  describe('withObservabilityContext', () => {
    test('sets context for synchronous callback', () => {
      let captured: ReturnType<typeof getObservabilityContext>;

      withObservabilityContext({ conversationId: 'conv-1' }, () => {
        captured = getObservabilityContext();
      });

      expect(captured!).toEqual({ conversationId: 'conv-1' });
    });

    test('sets context for async callback', async () => {
      let captured: ReturnType<typeof getObservabilityContext>;

      await withObservabilityContext(
        { conversationId: 'conv-2', platformType: 'web' },
        async () => {
          await new Promise(r => setTimeout(r, 10));
          captured = getObservabilityContext();
        }
      );

      expect(captured!).toEqual({ conversationId: 'conv-2', platformType: 'web' });
    });

    test('nested calls merge attributes (inner overrides outer)', () => {
      let outerCtx: ReturnType<typeof getObservabilityContext>;
      let innerCtx: ReturnType<typeof getObservabilityContext>;

      withObservabilityContext({ conversationId: 'conv-1', platformType: 'slack' }, () => {
        outerCtx = getObservabilityContext();
        withObservabilityContext({ workflowName: 'assist', platformType: 'cli' }, () => {
          innerCtx = getObservabilityContext();
        });
      });

      expect(outerCtx!).toEqual({ conversationId: 'conv-1', platformType: 'slack' });
      expect(innerCtx!).toEqual({
        conversationId: 'conv-1',
        platformType: 'cli',
        workflowName: 'assist',
      });
    });

    test('returns callback return value', () => {
      const result = withObservabilityContext({ conversationId: 'c' }, () => 42);
      expect(result).toBe(42);
    });

    test('returns async callback return value', async () => {
      const result = await withObservabilityContext({ conversationId: 'c' }, async () => {
        await new Promise(r => setTimeout(r, 1));
        return 'hello';
      });
      expect(result).toBe('hello');
    });
  });

  describe('getObservabilityContext', () => {
    test('returns undefined outside any context', () => {
      expect(getObservabilityContext()).toBeUndefined();
    });
  });

  // ─── isLangfuseEnabled ──────────────────────────────────────────────────

  describe('isLangfuseEnabled', () => {
    const origPK = process.env.LANGFUSE_PUBLIC_KEY;
    const origSK = process.env.LANGFUSE_SECRET_KEY;

    afterEach(() => {
      // Restore original env
      if (origPK !== undefined) process.env.LANGFUSE_PUBLIC_KEY = origPK;
      else delete process.env.LANGFUSE_PUBLIC_KEY;
      if (origSK !== undefined) process.env.LANGFUSE_SECRET_KEY = origSK;
      else delete process.env.LANGFUSE_SECRET_KEY;
    });

    test('returns false when no env vars set', () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      expect(isLangfuseEnabled()).toBe(false);
    });

    test('returns false when only public key set', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
      delete process.env.LANGFUSE_SECRET_KEY;
      expect(isLangfuseEnabled()).toBe(false);
    });

    test('returns false when only secret key set', () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      process.env.LANGFUSE_SECRET_KEY = 'sk-test';
      expect(isLangfuseEnabled()).toBe(false);
    });

    test('returns true when both keys set', () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-test';
      expect(isLangfuseEnabled()).toBe(true);
    });

    test('returns false for empty string keys', () => {
      process.env.LANGFUSE_PUBLIC_KEY = '';
      process.env.LANGFUSE_SECRET_KEY = '';
      expect(isLangfuseEnabled()).toBe(false);
    });
  });

  // ─── initLangfuse ──────────────────────────────────────────────────────

  describe('initLangfuse', () => {
    const origPK = process.env.LANGFUSE_PUBLIC_KEY;
    const origSK = process.env.LANGFUSE_SECRET_KEY;

    afterEach(async () => {
      await shutdownLangfuse();
      if (origPK !== undefined) process.env.LANGFUSE_PUBLIC_KEY = origPK;
      else delete process.env.LANGFUSE_PUBLIC_KEY;
      if (origSK !== undefined) process.env.LANGFUSE_SECRET_KEY = origSK;
      else delete process.env.LANGFUSE_SECRET_KEY;
    });

    test('returns false when env vars not set', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      const result = await initLangfuse();
      expect(result).toBe(false);
    });
  });

  // ─── traceQuery ─────────────────────────────────────────────────────────

  describe('traceQuery', () => {
    async function* fakeGenerator(): AsyncGenerator<MessageChunk> {
      yield { type: 'assistant', content: 'Hello ' };
      yield { type: 'assistant', content: 'world' };
      yield { type: 'result', sessionId: 'sess-1', tokens: { input: 10, output: 5 } };
    }

    test('passes through all chunks when Langfuse not initialized', async () => {
      const chunks: MessageChunk[] = [];
      for await (const chunk of traceQuery('test prompt', 'sonnet', fakeGenerator())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'Hello ' });
      expect(chunks[1]).toEqual({ type: 'assistant', content: 'world' });
      expect(chunks[2]).toMatchObject({ type: 'result', sessionId: 'sess-1' });
    });

    test('passes through tool call and tool result chunks', async () => {
      async function* toolGenerator(): AsyncGenerator<MessageChunk> {
        yield { type: 'tool', toolName: 'Read', toolInput: { path: '/file.ts' } };
        yield { type: 'tool_result', toolName: 'Read', toolOutput: 'file content here' };
        yield { type: 'assistant', content: 'I read the file.' };
        yield { type: 'result', sessionId: 'sess-2', tokens: { input: 50, output: 20 } };
      }

      const chunks: MessageChunk[] = [];
      for await (const chunk of traceQuery('read a file', 'sonnet', toolGenerator())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toMatchObject({ type: 'tool', toolName: 'Read' });
      expect(chunks[1]).toMatchObject({ type: 'tool_result', toolName: 'Read' });
      expect(chunks[2]).toEqual({ type: 'assistant', content: 'I read the file.' });
      expect(chunks[3]).toMatchObject({ type: 'result', sessionId: 'sess-2' });
    });

    test('handles empty generator', async () => {
      async function* emptyGenerator(): AsyncGenerator<MessageChunk> {
        // yields nothing
      }

      const chunks: MessageChunk[] = [];
      for await (const chunk of traceQuery('empty', 'sonnet', emptyGenerator())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(0);
    });

    test('passes through cost and numTurns from result', async () => {
      async function* costGenerator(): AsyncGenerator<MessageChunk> {
        yield { type: 'assistant', content: 'done' };
        yield {
          type: 'result',
          sessionId: 'sess-3',
          tokens: { input: 100, output: 50, total: 150 },
          cost: 0.0042,
          numTurns: 3,
        };
      }

      const chunks: MessageChunk[] = [];
      for await (const chunk of traceQuery('test', 'opus', costGenerator())) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      const result = chunks[1];
      expect(result).toMatchObject({
        type: 'result',
        cost: 0.0042,
        numTurns: 3,
      });
    });

    test('preserves generator error propagation', async () => {
      async function* errorGenerator(): AsyncGenerator<MessageChunk> {
        yield { type: 'assistant', content: 'partial' };
        throw new Error('stream failed');
      }

      const chunks: MessageChunk[] = [];
      await expect(async () => {
        for await (const chunk of traceQuery('test', 'sonnet', errorGenerator())) {
          chunks.push(chunk);
        }
      }).toThrow('stream failed');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ type: 'assistant', content: 'partial' });
    });
  });

  // ─── shutdownLangfuse ──────────────────────────────────────────────────

  describe('shutdownLangfuse', () => {
    test('is safe to call when not initialized', async () => {
      // Should not throw
      await shutdownLangfuse();
    });

    test('is safe to call multiple times', async () => {
      await shutdownLangfuse();
      await shutdownLangfuse();
    });
  });
});
