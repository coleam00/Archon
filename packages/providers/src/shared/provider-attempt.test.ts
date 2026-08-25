import { afterEach, describe, expect, jest, test } from 'bun:test';
import type { MessageChunk, SendQueryOptions } from '../types';
import {
  confirmProviderAttemptStopped,
  PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS,
  ProviderAttemptStopUnconfirmedError,
  withProviderAttempt,
} from './provider-attempt';

afterEach(() => {
  jest.useRealTimers();
});

describe('confirmProviderAttemptStopped', () => {
  test('accepts confirmed shutdown', async () => {
    await expect(confirmProviderAttemptStopped(async () => undefined, 'stop failed')).resolves.toBe(
      undefined
    );
  });

  test('wraps rejected shutdown as unconfirmed', async () => {
    await expect(
      confirmProviderAttemptStopped(
        async () => Promise.reject(new Error('transport failed')),
        'stop failed'
      )
    ).rejects.toMatchObject({ name: 'ProviderAttemptStopUnconfirmedError' });
  });

  test('wraps a synchronous shutdown throw as unconfirmed', async () => {
    await expect(
      confirmProviderAttemptStopped(() => {
        throw new Error('sync transport failure');
      }, 'stop failed')
    ).rejects.toMatchObject({ name: 'ProviderAttemptStopUnconfirmedError' });
  });

  test('bounds a shutdown promise that never settles', async () => {
    jest.useFakeTimers();
    const confirmation = confirmProviderAttemptStopped(
      () => new Promise(() => undefined),
      'stop failed'
    );

    jest.advanceTimersByTime(PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS);

    await expect(confirmation).rejects.toMatchObject({
      name: 'ProviderAttemptStopUnconfirmedError',
    });
  });
});

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
            release: async ({ upstreamStopped }) => {
              order.push(`release:${String(upstreamStopped)}`);
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
    expect(order).toEqual(['acquire', 'start', 'release:true']);
  });

  test('releases confirmed capacity after a successful upstream attempt', async () => {
    let releaseOptions: { upstreamStopped: boolean } | undefined;
    const chunks = await consume(
      withProviderAttempt(
        {
          providerAttemptGate: {
            acquire: async () => ({
              signal: new AbortController().signal,
              release: async options => {
                releaseOptions = options;
              },
            }),
          },
        },
        async function* () {
          yield { type: 'assistant', content: 'ok' };
        }
      )
    );

    expect(chunks).toEqual([{ type: 'assistant', content: 'ok' }]);
    expect(releaseOptions).toEqual({ upstreamStopped: true });
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

  test('does not start upstream work when cancellation wins during acquisition', async () => {
    const controller = new AbortController();
    let started = false;
    let released = false;
    const result = consume(
      withProviderAttempt(
        {
          abortSignal: controller.signal,
          providerAttemptGate: {
            acquire: async () => {
              controller.abort(new Error('cancelled while claiming'));
              return {
                signal: new AbortController().signal,
                release: async () => {
                  released = true;
                },
              };
            },
          },
        },
        async function* () {
          started = true;
          yield { type: 'assistant', content: 'should not start' };
        }
      )
    );

    await expect(result).rejects.toThrow('cancelled while claiming');
    expect(started).toBe(false);
    expect(released).toBe(true);
  });

  test('preserves capacity until expiry when upstream shutdown cannot be confirmed', async () => {
    let releaseOptions: { upstreamStopped?: boolean } | undefined;
    const result = consume(
      withProviderAttempt(
        {
          providerAttemptGate: {
            acquire: async () => ({
              signal: new AbortController().signal,
              release: async options => {
                releaseOptions = options;
              },
            }),
          },
        },
        async function* () {
          throw new ProviderAttemptStopUnconfirmedError('remote attempt may still be active');
        }
      )
    );

    await expect(result).rejects.toThrow('remote attempt may still be active');
    expect(releaseOptions).toEqual({ upstreamStopped: false });
  });
});
