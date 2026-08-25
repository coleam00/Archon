import { describe, expect, test } from 'bun:test';
import type { IAgentProvider, MessageChunk, ProviderCapabilities } from '@archon/providers/types';
import type { ProviderConcurrencyLease } from '../db/provider-concurrency';
import { createProviderQueryRunner } from './provider-query-runner';

const capabilities: ProviderCapabilities = {
  sessionResume: false,
  sessionFork: false,
  mcp: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: 'none',
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
};

function provider(stream: IAgentProvider['sendQuery']): IAgentProvider {
  return {
    supportsProviderAttemptGate: true,
    sendQuery: async function* (prompt, cwd, resumeSessionId, options) {
      const gate = options?.providerAttemptGate;
      if (!gate) {
        yield* stream(prompt, cwd, resumeSessionId, options);
        return;
      }

      const lease = await gate.acquire();
      try {
        yield* stream(prompt, cwd, resumeSessionId, {
          ...options,
          abortSignal: lease.signal,
        });
      } finally {
        await lease.release();
      }
    },
    getType: () => 'pi',
    getCapabilities: () => capabilities,
  };
}

async function consume(generator: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

describe('createProviderQueryRunner', () => {
  test('unlimited providers bypass acquisition', async () => {
    let acquireCalls = 0;
    const runner = createProviderQueryRunner({
      acquire: async () => {
        acquireCalls += 1;
        throw new Error('should not acquire');
      },
      loadLimits: async () => ({}),
    });
    const chunks = await consume(
      runner({
        client: provider(async function* () {
          yield { type: 'assistant', content: 'ok' };
        }),
        prompt: 'hello',
        cwd: '/tmp',
      })
    );

    expect(chunks).toEqual([{ type: 'assistant', content: 'ok' }]);
    expect(acquireCalls).toBe(0);
  });

  test('does not start a provider when install policy loading fails', async () => {
    let started = false;
    const policyError = new Error('policy unreadable');
    const runner = createProviderQueryRunner({
      acquire: async () => {
        throw new Error('should not acquire');
      },
      loadLimits: async () => {
        throw policyError;
      },
    });

    await expect(
      consume(
        runner({
          client: provider(async function* () {
            started = true;
            yield { type: 'assistant', content: 'should not start' };
          }),
          prompt: 'hello',
          cwd: '/tmp',
        })
      )
    ).rejects.toBe(policyError);
    expect(started).toBe(false);
  });

  test('configured caps fail closed for providers without the admission contract', async () => {
    let started = false;
    const uncappedOnlyProvider: IAgentProvider = {
      sendQuery: async function* () {
        started = true;
        yield { type: 'assistant', content: 'should not start' };
      },
      getType: () => 'community',
      getCapabilities: () => capabilities,
    };
    const runner = createProviderQueryRunner({
      acquire: async () => {
        throw new Error('should not acquire');
      },
      loadLimits: async () => ({ community: 1 }),
    });

    await expect(
      consume(
        runner({
          client: uncappedOnlyProvider,
          prompt: 'hello',
          cwd: '/tmp',
        })
      )
    ).rejects.toThrow("Provider 'community' does not support install-wide concurrency admission");
    expect(started).toBe(false);
  });

  test('acquires before starting and releases after completion', async () => {
    const order: string[] = [];
    const lease: ProviderConcurrencyLease = {
      provider: 'pi',
      slot: 0,
      signal: new AbortController().signal,
      release: async () => {
        order.push('release');
      },
    };
    const runner = createProviderQueryRunner({
      acquire: async () => {
        order.push('acquire');
        return lease;
      },
      loadLimits: async () => ({ pi: 1 }),
    });

    await consume(
      runner({
        client: provider(async function* () {
          order.push('start');
          yield { type: 'assistant', content: 'ok' };
        }),
        prompt: 'hello',
        cwd: '/tmp',
      })
    );

    expect(order).toEqual(['acquire', 'start', 'release']);
  });

  test('carries terminal workflow ownership through admission without starting the provider', async () => {
    let started = false;
    let observedShouldContinue = false;
    const runner = createProviderQueryRunner({
      acquire: async (_provider, _limit, options) => {
        observedShouldContinue = (await options?.shouldContinue?.()) === false;
        throw new Error('terminal owner');
      },
      loadLimits: async () => ({ pi: 1 }),
    });

    await expect(
      consume(
        runner({
          client: provider(async function* () {
            started = true;
            yield { type: 'assistant', content: 'should not start' };
          }),
          prompt: 'hello',
          cwd: '/tmp',
          context: { shouldContinue: async () => false },
        })
      )
    ).rejects.toThrow('terminal owner');
    expect(observedShouldContinue).toBe(true);
    expect(started).toBe(false);
  });

  test('keeps a multi-attempt query queued until its last waiter acquires', async () => {
    let acquireCalls = 0;
    let releaseBoth!: () => void;
    const bothQueued = new Promise<void>(resolve => {
      releaseBoth = resolve;
    });
    const transitions: string[] = [];
    const runner = createProviderQueryRunner({
      acquire: async (providerId, limit, options) => {
        acquireCalls += 1;
        options?.observer?.onQueued?.({ provider: providerId, limit });
        if (acquireCalls === 2) releaseBoth();
        await bothQueued;
        options?.observer?.onAcquired?.({
          provider: providerId,
          limit,
          slot: acquireCalls,
          waitMs: 1,
        });
        return {
          provider: providerId,
          slot: acquireCalls,
          signal: new AbortController().signal,
          release: async () => undefined,
        };
      },
      loadLimits: async () => ({ pi: 1 }),
    });
    const multiAttemptProvider: IAgentProvider = {
      supportsProviderAttemptGate: true,
      getType: () => 'pi',
      getCapabilities: () => capabilities,
      sendQuery: async function* (_prompt, _cwd, _resume, options) {
        const attemptGate = options?.providerAttemptGate;
        if (!attemptGate) throw new Error('missing attempt gate');
        const leases = await Promise.all([attemptGate.acquire(), attemptGate.acquire()]);
        for (const lease of leases) await lease.release();
        yield { type: 'assistant', content: 'ok' };
      },
    };

    await consume(
      runner({
        client: multiAttemptProvider,
        prompt: 'hello',
        cwd: '/tmp',
        context: {
          onQueued: () => transitions.push('queued'),
          onAcquired: () => transitions.push('acquired'),
        },
      })
    );

    expect(transitions).toEqual(['queued', 'acquired']);
  });

  test('clears an aborted waiter so a provider retry can return to running', async () => {
    let acquireCalls = 0;
    const transitions: string[] = [];
    const runner = createProviderQueryRunner({
      acquire: async (providerId, limit, options) => {
        acquireCalls += 1;
        options?.observer?.onQueued?.({ provider: providerId, limit });
        if (acquireCalls === 1) {
          options?.observer?.onDequeued?.({ provider: providerId, limit });
          throw new Error('queued sibling aborted');
        }
        options?.observer?.onAcquired?.({ provider: providerId, limit, slot: 0, waitMs: 1 });
        return {
          provider: providerId,
          slot: 0,
          signal: new AbortController().signal,
          release: async () => undefined,
        };
      },
      loadLimits: async () => ({ pi: 1 }),
    });
    const retryingProvider: IAgentProvider = {
      supportsProviderAttemptGate: true,
      getType: () => 'pi',
      getCapabilities: () => capabilities,
      sendQuery: async function* (_prompt, _cwd, _resume, options) {
        const attemptGate = options?.providerAttemptGate;
        if (!attemptGate) throw new Error('missing attempt gate');
        await expect(attemptGate.acquire()).rejects.toThrow('queued sibling aborted');
        const lease = await attemptGate.acquire();
        await lease.release();
        yield { type: 'assistant', content: 'ok' };
      },
    };

    await consume(
      runner({
        client: retryingProvider,
        prompt: 'hello',
        cwd: '/tmp',
        context: {
          onQueued: () => transitions.push('queued'),
          onAcquired: () => transitions.push('acquired'),
        },
      })
    );

    expect(transitions).toEqual(['queued', 'queued', 'acquired']);
  });

  test('releases when the provider throws', async () => {
    let released = false;
    const runner = createProviderQueryRunner({
      acquire: async () => ({
        provider: 'pi',
        slot: 0,
        signal: new AbortController().signal,
        release: async () => {
          released = true;
        },
      }),
      loadLimits: async () => ({ pi: 1 }),
    });

    await expect(
      consume(
        runner({
          client: provider(async function* () {
            throw new Error('provider failed');
          }),
          prompt: 'hello',
          cwd: '/tmp',
        })
      )
    ).rejects.toThrow('provider failed');
    expect(released).toBe(true);
  });

  test('releases when the consumer returns early', async () => {
    let released = false;
    const runner = createProviderQueryRunner({
      acquire: async () => ({
        provider: 'pi',
        slot: 0,
        signal: new AbortController().signal,
        release: async () => {
          released = true;
        },
      }),
      loadLimits: async () => ({ pi: 1 }),
    });
    const generator = runner({
      client: provider(async function* () {
        yield { type: 'assistant', content: 'first' };
        yield { type: 'assistant', content: 'second' };
      }),
      prompt: 'hello',
      cwd: '/tmp',
    });

    await generator.next();
    await generator.return(undefined);
    expect(released).toBe(true);
  });

  test('aborts the provider stream and releases when lease ownership is lost', async () => {
    const leaseController = new AbortController();
    let released = false;
    let started = false;
    const runner = createProviderQueryRunner({
      acquire: async () => ({
        provider: 'pi',
        slot: 0,
        signal: leaseController.signal,
        release: async () => {
          released = true;
        },
      }),
      loadLimits: async () => ({ pi: 1 }),
    });
    const result = consume(
      runner({
        client: provider(async function* (_prompt, _cwd, _resumeSessionId, options) {
          started = true;
          await new Promise<void>(resolve => {
            options?.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw options?.abortSignal?.reason;
        }),
        prompt: 'hello',
        cwd: '/tmp',
      })
    );

    while (!started) await Bun.sleep(1);
    leaseController.abort(new Error('lease lost'));

    await expect(result).rejects.toThrow('lease lost');
    expect(released).toBe(true);
  });

  test('releases before provider retry backoff and reacquires for the next attempt', async () => {
    const order: string[] = [];
    let attempt = 0;
    const runner = createProviderQueryRunner({
      acquire: async () => {
        order.push(`acquire-${attempt}`);
        return {
          provider: 'pi',
          slot: 0,
          signal: new AbortController().signal,
          release: async () => {
            order.push(`release-${attempt}`);
          },
        };
      },
      loadLimits: async () => ({ pi: 1 }),
    });
    const retryingProvider: IAgentProvider = {
      ...provider(async function* () {
        yield { type: 'assistant', content: 'unused' };
      }),
      sendQuery: async function* (prompt, cwd, resumeSessionId, options) {
        for (attempt = 1; attempt <= 2; attempt += 1) {
          const lease = await options?.providerAttemptGate?.acquire();
          if (!lease) throw new Error('missing attempt gate');
          try {
            order.push(`start-${attempt}`);
            if (attempt === 1) throw new Error('retryable');
            yield { type: 'assistant', content: 'ok' };
            return;
          } catch (error) {
            if (attempt === 2) throw error;
          } finally {
            await lease.release();
          }
          order.push('backoff');
        }
      },
    };

    await consume(
      runner({
        client: retryingProvider,
        prompt: 'hello',
        cwd: '/tmp',
      })
    );

    expect(order).toEqual([
      'acquire-1',
      'start-1',
      'release-1',
      'backoff',
      'acquire-2',
      'start-2',
      'release-2',
    ]);
  });
});
