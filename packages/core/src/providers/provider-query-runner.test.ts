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

function provider(stream: () => AsyncGenerator<MessageChunk>): IAgentProvider {
  return {
    sendQuery: stream,
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
        provider: 'pi',
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
        provider: 'pi',
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
          provider: 'pi',
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
      provider: 'pi',
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
});
