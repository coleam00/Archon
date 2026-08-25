import { describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  lazyStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
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
});
