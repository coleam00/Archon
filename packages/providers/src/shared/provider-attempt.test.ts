import { describe, expect, test } from 'bun:test';
import type { MessageChunk, SendQueryOptions } from '../types';
import { withProviderAttempt } from './provider-attempt';

async function consume(generator: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of generator) chunks.push(chunk);
  return chunks;
}

describe('withProviderAttempt', () => {
  test('delegates directly when no admission gate is configured', async () => {
    const controller = new AbortController();
    const chunks = await consume(
      withProviderAttempt({ abortSignal: controller.signal }, async function* (signal) {
        expect(signal).toBe(controller.signal);
        yield { type: 'assistant', content: 'ok' };
      })
    );

    expect(chunks).toEqual([{ type: 'assistant', content: 'ok' }]);
  });

  test('holds one lease around the upstream attempt and releases on failure', async () => {
    const order: string[] = [];
    const options: SendQueryOptions = {
      providerAttemptGate: {
        acquire: async () => {
          order.push('acquire');
          return {
            signal: new AbortController().signal,
            release: async () => {
              order.push('release');
            },
          };
        },
      },
    };

    await expect(
      consume(
        withProviderAttempt(options, async function* () {
          order.push('start');
          throw new Error('attempt failed');
        })
      )
    ).rejects.toThrow('attempt failed');
    expect(order).toEqual(['acquire', 'start', 'release']);
  });

  test('forwards lease ownership loss to the active attempt', async () => {
    const leaseController = new AbortController();
    let released = false;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const result = consume(
      withProviderAttempt(
        {
          providerAttemptGate: {
            acquire: async () => ({
              signal: leaseController.signal,
              release: async () => {
                released = true;
              },
            }),
          },
        },
        async function* (signal) {
          markStarted?.();
          await new Promise<void>(resolve => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw signal?.reason;
        }
      )
    );

    await started;
    leaseController.abort(new Error('lease lost'));
    await expect(result).rejects.toThrow('lease lost');
    expect(released).toBe(true);
  });
});
