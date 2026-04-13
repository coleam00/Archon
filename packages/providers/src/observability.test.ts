import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  withObservabilityContext,
  getObservabilityContext,
  isLangfuseEnabled,
  getQuery,
  initLangfuse,
  shutdownLangfuse,
} from './observability';

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

  // ─── getQuery ──────────────────────────────────────────────────────────

  describe('getQuery', () => {
    test('returns a function', () => {
      const queryFn = getQuery();
      expect(typeof queryFn).toBe('function');
    });

    test('returns the SDK query function when Langfuse not initialized', () => {
      const queryFn = getQuery();
      // Should be a callable function (original SDK query)
      expect(typeof queryFn).toBe('function');
      // Should NOT be the instrumented wrapper
      expect(queryFn.name).not.toBe('wrappedQuery');
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
