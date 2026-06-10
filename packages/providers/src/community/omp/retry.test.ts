import { describe, expect, test } from 'bun:test';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent';

import type { MessageChunk } from '../../types';
import { bridgeSessionWithRetry } from './retry';
import { createOmpDiagnosticsContext } from './diagnostics';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type FakeEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'agent_end'; messages: readonly unknown[] };

function textDelta(delta: string): FakeEvent {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } };
}

function agentEnd(text = 'done'): FakeEvent {
  return {
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'stop', usage, content: [{ type: 'text', text }] }],
  };
}

interface FakeSession {
  promptCalls: number;
  disposed: boolean;
  session: AgentSession;
}

/**
 * Fake session that throws if prompted after dispose — the exact failure mode
 * of the 70eaa443 same-session retry bug.
 */
function makeFakeSession(behavior: {
  /** Events emitted before prompt settles. */
  events?: readonly FakeEvent[];
  /** When set, prompt() rejects with this error after emitting `events`. */
  rejectWith?: Error;
}): FakeSession {
  let listener: ((event: FakeEvent) => void) | undefined;
  const state: FakeSession = {
    promptCalls: 0,
    disposed: false,
    session: undefined as unknown as AgentSession,
  };
  state.session = {
    subscribe(fn: (event: FakeEvent) => void) {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    prompt: async () => {
      state.promptCalls += 1;
      if (state.disposed) {
        throw new Error('prompt() called on a disposed session (regression: 70eaa443)');
      }
      for (const event of behavior.events ?? []) listener?.(event);
      if (behavior.rejectWith) throw behavior.rejectWith;
    },
    abort() {
      /* noop */
    },
    dispose: async () => {
      state.disposed = true;
    },
  } as unknown as AgentSession;
  return state;
}

async function consume(
  gen: AsyncGenerator<MessageChunk>
): Promise<{ chunks: MessageChunk[]; error?: Error }> {
  const chunks: MessageChunk[] = [];
  try {
    for await (const chunk of gen) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

function makeDiagnostics() {
  return createOmpDiagnosticsContext({
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    cwd: '/tmp',
    resumed: false,
  });
}

describe('bridgeSessionWithRetry', () => {
  test('pre-stream transient failure retries with a FRESH session (factory called twice)', async () => {
    const sessions: FakeSession[] = [];
    let factoryCalls = 0;
    const factory = async (): Promise<AgentSession> => {
      factoryCalls += 1;
      const fake =
        factoryCalls === 1
          ? makeFakeSession({ rejectWith: new Error('ECONNRESET: socket hang up') })
          : makeFakeSession({ events: [textDelta('recovered'), agentEnd()] });
      sessions.push(fake);
      return fake.session;
    };

    const { chunks, error } = await consume(
      bridgeSessionWithRetry(factory, 'prompt', undefined, undefined, undefined, {
        baseDelayMs: 1,
      })
    );

    expect(error).toBeUndefined();
    expect(factoryCalls).toBe(2);
    expect(sessions[0]?.promptCalls).toBe(1);
    expect(sessions[1]?.promptCalls).toBe(1);
    // attempt 1's session was disposed and never re-prompted
    expect(sessions[0]?.disposed).toBe(true);

    const retryNotice = chunks.find(
      c => c.type === 'system' && c.content.includes('OMP transient error')
    );
    expect(retryNotice).toBeDefined();
    if (retryNotice?.type === 'system') {
      expect(retryNotice.content).toContain('attempt 1/3');
      expect(retryNotice.content).toContain('fresh session');
    }
    expect(chunks.some(c => c.type === 'assistant' && c.content === 'recovered')).toBe(true);
    expect(chunks.some(c => c.type === 'result')).toBe(true);
  });

  test('regression: never re-prompts a disposed session (70eaa443 bug shape)', async () => {
    // With the old same-session signature, attempt 2 would call prompt() on
    // the session disposed by attempt 1's finally — and this fake throws the
    // disposed-session error in that case. With the factory design, every
    // attempt gets a fresh session, so the error never mentions disposal.
    const sessions: FakeSession[] = [];
    const factory = async (): Promise<AgentSession> => {
      const fake = makeFakeSession({ rejectWith: new Error('503 service unavailable') });
      sessions.push(fake);
      return fake.session;
    };

    const { error } = await consume(
      bridgeSessionWithRetry(factory, 'prompt', undefined, undefined, undefined, {
        maxAttempts: 3,
        baseDelayMs: 1,
      })
    );

    expect(error).toBeDefined();
    expect(error?.message).not.toContain('disposed session');
    expect(error?.message).toContain('503 service unavailable');
    expect(sessions).toHaveLength(3);
    for (const fake of sessions) {
      expect(fake.promptCalls).toBe(1); // each session prompted exactly once
      expect(fake.disposed).toBe(true); // and disposed by its own bridge
    }
  });

  test('mid-stream transient failure does NOT retry', async () => {
    let factoryCalls = 0;
    const factory = async (): Promise<AgentSession> => {
      factoryCalls += 1;
      return makeFakeSession({
        events: [textDelta('partial output')],
        rejectWith: new Error('socket hang up'),
      }).session;
    };

    const { chunks, error } = await consume(
      bridgeSessionWithRetry(factory, 'prompt', undefined, undefined, undefined, {
        baseDelayMs: 1,
      })
    );

    expect(factoryCalls).toBe(1);
    expect(error).toBeDefined();
    expect(error?.message).toContain('socket hang up');
    // mid-stream errors come enriched from the bridge
    expect(error?.message).toContain('[omp diagnostics:');
    expect(chunks.some(c => c.type === 'assistant')).toBe(true);
    expect(chunks.some(c => c.type === 'system')).toBe(false);
  });

  test('FATAL errors never retry', async () => {
    let factoryCalls = 0;
    const factory = async (): Promise<AgentSession> => {
      factoryCalls += 1;
      return makeFakeSession({ rejectWith: new Error('401 unauthorized') }).session;
    };

    const { error } = await consume(
      bridgeSessionWithRetry(factory, 'prompt', undefined, undefined, undefined, {
        baseDelayMs: 1,
      })
    );

    expect(factoryCalls).toBe(1);
    expect(error?.message).toContain('401 unauthorized');
  });

  test('session factory rejection is retried when transient', async () => {
    let factoryCalls = 0;
    const factory = async (): Promise<AgentSession> => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error('ETIMEDOUT creating session');
      return makeFakeSession({ events: [agentEnd()] }).session;
    };

    const { chunks, error } = await consume(
      bridgeSessionWithRetry(factory, 'prompt', undefined, undefined, undefined, {
        baseDelayMs: 1,
      })
    );

    expect(error).toBeUndefined();
    expect(factoryCalls).toBe(2);
    expect(chunks.some(c => c.type === 'result')).toBe(true);
  });

  test('retry notice includes ledger summary for raw failures when ledger is non-empty', async () => {
    const diagnostics = makeDiagnostics();
    // Pre-seed the ledger as if a previous turn had tool activity.
    diagnostics.recordToolStart('bash', 'c1', { command: 'ls' });
    diagnostics.recordToolEnd('bash', 'c1', 'ok', false);

    let factoryCalls = 0;
    const factory = async (): Promise<AgentSession> => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error('network error during session create');
      return makeFakeSession({ events: [agentEnd()] }).session;
    };

    const { chunks, error } = await consume(
      bridgeSessionWithRetry(factory, 'prompt', undefined, undefined, undefined, {
        baseDelayMs: 1,
        diagnostics,
      })
    );

    expect(error).toBeUndefined();
    const retryNotice = chunks.find(
      c => c.type === 'system' && c.content.includes('OMP transient error')
    );
    expect(retryNotice).toBeDefined();
    if (retryNotice?.type === 'system') {
      expect(retryNotice.content).toContain('[omp diagnostics:');
      expect(retryNotice.content).toContain('bash#c1');
    }
  });
});
