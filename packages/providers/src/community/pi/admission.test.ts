import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  lazyStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS } from '../../shared/provider-attempt';
import { installPiAdmission } from './provider';

const model: Model<Api> = {
  id: 'test-model',
  provider: 'test-provider',
  name: 'Test model',
  api: 'openai-completions',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};

function message(stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe('installPiAdmission', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('leases each model stream separately and disables nested transport retries', async () => {
    const lifecycle: string[] = [];
    const seenOptions: (SimpleStreamOptions | undefined)[] = [];
    const streamSimple = mock<ModelRuntime['streamSimple']>((_model, _context, options) => {
      lifecycle.push('upstream');
      seenOptions.push(options);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: message() });
      return stream;
    });
    const runtime: Pick<ModelRuntime, 'streamSimple'> = { streamSimple };
    let active = 0;
    let maxActive = 0;
    installPiAdmission(
      runtime,
      {
        acquire: async () => {
          lifecycle.push('acquire');
          active += 1;
          maxActive = Math.max(maxActive, active);
          let released = false;
          return {
            signal: new AbortController().signal,
            release: async () => {
              if (released) return;
              released = true;
              active -= 1;
              lifecycle.push('release');
            },
          };
        },
      },
      lazyStream
    );

    const consume = async (): Promise<void> => {
      for await (const _event of runtime.streamSimple(model, { messages: [] }, { maxRetries: 7 })) {
        // Consume the complete attempt so the lease's finally runs.
      }
    };
    await consume();
    lifecycle.push('backoff');
    await consume();

    expect(lifecycle).toEqual([
      'acquire',
      'upstream',
      'release',
      'backoff',
      'acquire',
      'upstream',
      'release',
    ]);
    expect(seenOptions.map(options => options?.maxRetries)).toEqual([0, 0]);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });

  test('releases the lease when the inner stream fails', async () => {
    const runtime: Pick<ModelRuntime, 'streamSimple'> = {
      streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        const error = { ...message('error'), errorMessage: 'upstream failed' };
        stream.push({ type: 'error', reason: 'error', error });
        return stream;
      },
    };
    let releases = 0;
    installPiAdmission(
      runtime,
      {
        acquire: async () => ({
          signal: new AbortController().signal,
          release: async () => {
            releases += 1;
          },
        }),
      },
      lazyStream
    );

    for await (const _event of runtime.streamSimple(model, { messages: [] } satisfies Context)) {
      // The error is a terminal stream event, not a thrown exception.
    }
    expect(releases).toBe(1);
  });

  test('forwards lease ownership loss to the active Pi model stream', async () => {
    const leaseController = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const streamSimple = mock<ModelRuntime['streamSimple']>((_model, _context, options) => {
      upstreamSignal = options?.signal;
      const stream = createAssistantMessageEventStream();
      upstreamSignal?.addEventListener(
        'abort',
        () => stream.push({ type: 'done', reason: 'stop', message: message() }),
        { once: true }
      );
      return stream;
    });
    const runtime: Pick<ModelRuntime, 'streamSimple'> = { streamSimple };
    const releases: { upstreamStopped: boolean }[] = [];
    installPiAdmission(
      runtime,
      {
        acquire: async () => ({
          signal: leaseController.signal,
          release: async options => {
            releases.push(options);
          },
        }),
      },
      lazyStream
    );

    const events: AssistantMessageEvent[] = [];
    const consumption = (async (): Promise<void> => {
      for await (const event of runtime.streamSimple(model, { messages: [] })) {
        events.push(event);
      }
    })();
    while (!upstreamSignal) await Bun.sleep(1);
    const leaseLost = new Error('lease ownership lost');
    leaseController.abort(leaseLost);

    await consumption;
    expect(upstreamSignal.aborted).toBe(true);
    expect(upstreamSignal.reason).toBe(leaseLost);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].error.errorMessage).toBe('lease ownership lost');
    }
    expect(releases).toEqual([{ upstreamStopped: false }]);
  });

  test('does not treat consumer iterator closure as proof that Pi stopped', async () => {
    const leaseController = new AbortController();
    const streamSimple = mock<ModelRuntime['streamSimple']>(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message() });
      return stream;
    });
    const runtime: Pick<ModelRuntime, 'streamSimple'> = { streamSimple };
    const releases: { upstreamStopped: boolean }[] = [];
    installPiAdmission(
      runtime,
      {
        acquire: async () => ({
          signal: leaseController.signal,
          release: async options => {
            releases.push(options);
          },
        }),
      },
      lazyStream
    );

    const iterator = runtime.streamSimple(model, { messages: [] })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('start');
    jest.useFakeTimers();
    leaseController.abort(new Error('lease ownership lost'));
    const completion = (async (): Promise<void> => {
      while (!(await iterator.next()).done) {
        // Drain the error event that closes the public lazy stream.
      }
    })();
    for (let attempt = 0; attempt < 20 && releases.length === 0; attempt++) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS);
    await completion;

    expect(releases).toEqual([{ upstreamStopped: false }]);
  });

  test('releases an unused lease when ownership is already lost before stream creation', async () => {
    const leaseController = new AbortController();
    leaseController.abort(new Error('lease ownership lost'));
    const streamSimple = mock<ModelRuntime['streamSimple']>(() =>
      createAssistantMessageEventStream()
    );
    const runtime: Pick<ModelRuntime, 'streamSimple'> = { streamSimple };
    const releases: { upstreamStopped: boolean }[] = [];
    installPiAdmission(
      runtime,
      {
        acquire: async () => ({
          signal: leaseController.signal,
          release: async options => {
            releases.push(options);
          },
        }),
      },
      lazyStream
    );

    const events: AssistantMessageEvent[] = [];
    for await (const event of runtime.streamSimple(model, { messages: [] })) {
      events.push(event);
    }

    expect(streamSimple).not.toHaveBeenCalled();
    expect(releases).toEqual([{ upstreamStopped: true }]);
    expect(events.at(-1)?.type).toBe('error');
  });

  test('expires the lease when cancellation cannot stop a stalled Pi stream', async () => {
    const leaseController = new AbortController();
    const nextStarted = Promise.withResolvers<void>();
    const returnCall = mock(
      () => new Promise<IteratorResult<AssistantMessageEvent>>(() => undefined)
    );
    const streamSimple = mock<ModelRuntime['streamSimple']>(
      () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                nextStarted.resolve();
                return new Promise<IteratorResult<AssistantMessageEvent>>(() => undefined);
              },
              return: returnCall,
            };
          },
        }) as unknown as ReturnType<ModelRuntime['streamSimple']>
    );
    const runtime: Pick<ModelRuntime, 'streamSimple'> = { streamSimple };
    const releases: { upstreamStopped: boolean }[] = [];
    installPiAdmission(
      runtime,
      {
        acquire: async () => ({
          signal: leaseController.signal,
          release: async options => {
            releases.push(options);
          },
        }),
      },
      lazyStream
    );

    const events: AssistantMessageEvent[] = [];
    const consumption = (async (): Promise<void> => {
      for await (const event of runtime.streamSimple(model, { messages: [] })) {
        events.push(event);
      }
    })();
    await nextStarted.promise;
    jest.useFakeTimers();
    leaseController.abort(new Error('lease ownership lost'));
    for (let attempt = 0; attempt < 20 && returnCall.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(PROVIDER_STOP_CONFIRMATION_TIMEOUT_MS);
    await consumption;

    expect(returnCall).toHaveBeenCalledTimes(1);
    expect(releases).toEqual([{ upstreamStopped: false }]);
    expect(events.at(-1)?.type).toBe('error');
  });
});
