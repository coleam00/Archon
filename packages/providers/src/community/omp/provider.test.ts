import { describe, expect, test } from 'bun:test';

import { augmentPromptForJsonSchema, OmpProvider } from './provider';
import type {
  OmpCodingAgentSdk,
  OmpCreateAgentSessionOptions,
  OmpExtensionRunner,
  OmpSession,
} from './sdk-loader';
import type { MessageChunk } from '../../types';

interface FakeSdkOptions {
  model?: unknown;
  apiKey?: string;
  extensionRunner?: OmpExtensionRunner;
  onCreateAgentSession?: (options: OmpCreateAgentSessionOptions) => void;
  onSettingsIsolated?: (overrides: Record<string, unknown>) => void;
  onSetToolUIContext?: (uiContext: unknown, hasUI: boolean) => void;
  onSetRuntimeApiKey?: (provider: string, apiKey: string) => void;
  onPrompt?: () => void | Promise<void>;
}

async function collectChunks(
  provider: OmpProvider,
  options: Parameters<OmpProvider['sendQuery']>[3]
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of provider.sendQuery('hi', '/repo', undefined, options)) {
    chunks.push(chunk);
  }
  return chunks;
}

function makeSdk(options: FakeSdkOptions = {}): OmpCodingAgentSdk {
  const session: OmpSession = {
    sessionId: 'sess-1',
    ...(options.extensionRunner ? { extensionRunner: options.extensionRunner } : {}),
    subscribe(listener) {
      this.listener = listener;
      return () => undefined;
    },
    async prompt() {
      await options.onPrompt?.();
      const listener = this.listener as ((event: unknown) => void) | undefined;
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '{"ok":true}' },
      });
      listener?.({
        type: 'agent_end',
        messages: [{ role: 'assistant', usage: { input: 1, output: 1 }, stopReason: 'end_turn' }],
      });
    },
    async abort() {
      return undefined;
    },
    dispose() {
      return undefined;
    },
  } as OmpSession & { listener?: (event: unknown) => void };

  return {
    async createAgentSession(sessionOptions) {
      options.onCreateAgentSession?.(sessionOptions);
      return {
        session,
        setToolUIContext(uiContext, hasUI) {
          options.onSetToolUIContext?.(uiContext, hasUI);
        },
      };
    },
    async discoverAuthStorage() {
      return {
        setRuntimeApiKey(provider, apiKey) {
          options.onSetRuntimeApiKey?.(provider, apiKey);
        },
        async getApiKey() {
          return options.apiKey ?? 'sk-test';
        },
      };
    },
    ModelRegistry: class {
      refreshInBackground(): void {
        return undefined;
      }
      find(): unknown {
        return options.model ?? { provider: 'anthropic', id: 'claude-sonnet-4-5' };
      }
    },
    Settings: {
      isolated(overrides = {}) {
        options.onSettingsIsolated?.(overrides);
        return { overrides };
      },
    },
    SessionManager: {
      getDefaultSessionDir() {
        return '/tmp/omp-sessions';
      },
      create() {
        return {};
      },
      async list() {
        return [];
      },
      async open() {
        return {};
      },
    },
    async discoverSkills() {
      return { skills: [] };
    },
  };
}

describe('OmpProvider', () => {
  test('reports type and capabilities', () => {
    const provider = new OmpProvider(async () => makeSdk());
    expect(provider.getType()).toBe('omp');
    expect(provider.getCapabilities().sessionResume).toBe(true);
  });

  test('throws on missing model', async () => {
    const provider = new OmpProvider(async () => makeSdk());
    await expect(async () => {
      for await (const _chunk of provider.sendQuery('hi', '/repo')) {
        // consume
      }
    }).toThrow('requires a model');
  });

  test('streams assistant and result chunks', async () => {
    const provider = new OmpProvider(async () => makeSdk());
    const chunks = await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(chunks).toContainEqual({ type: 'assistant', content: '{"ok":true}' });
    expect(chunks.at(-1)).toEqual({
      type: 'result',
      tokens: { input: 1, output: 1 },
      stopReason: 'end_turn',
      sessionId: 'sess-1',
      structuredOutput: { ok: true },
    });
  });

  test('passes verified settings overrides to isolated OMP settings', async () => {
    let settingsOverrides: Record<string, unknown> | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSettingsIsolated(overrides) {
          settingsOverrides = overrides;
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: {
        settings: {
          retry: { enabled: false, maxRetries: 2 },
          compaction: { enabled: true },
          contextPromotion: { enabled: false },
          modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
          enabledModels: ['anthropic/*'],
          modelProviderOrder: ['anthropic'],
          disabledProviders: ['experimental-provider'],
          disabledExtensions: ['risky-extension'],
        },
      },
    });

    expect(settingsOverrides).toEqual({
      'retry.enabled': false,
      'retry.maxRetries': 2,
      'compaction.enabled': true,
      'contextPromotion.enabled': false,
      modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
      enabledModels: ['anthropic/*'],
      modelProviderOrder: ['anthropic'],
      disabledProviders: ['experimental-provider'],
      disabledExtensions: ['risky-extension'],
    });
  });

  test('applies config env without overriding shell env and keeps auth overrides', async () => {
    const originalExisting = process.env.OMP_PROVIDER_TEST_EXISTING;
    const originalNew = process.env.OMP_PROVIDER_TEST_NEW;
    delete process.env.OMP_PROVIDER_TEST_NEW;
    process.env.OMP_PROVIDER_TEST_EXISTING = 'shell';
    let runtimeOverride: [string, string] | undefined;

    try {
      const provider = new OmpProvider(async () =>
        makeSdk({
          onSetRuntimeApiKey(providerName, apiKey) {
            runtimeOverride = [providerName, apiKey];
          },
        })
      );

      await collectChunks(provider, {
        model: 'anthropic/claude-sonnet-4-5',
        env: { ANTHROPIC_API_KEY: 'request-key' },
        assistantConfig: {
          env: {
            OMP_PROVIDER_TEST_EXISTING: 'config',
            OMP_PROVIDER_TEST_NEW: 'configured',
          },
        },
      });

      expect(process.env.OMP_PROVIDER_TEST_EXISTING).toBe('shell');
      expect(process.env.OMP_PROVIDER_TEST_NEW).toBeUndefined();
      expect(runtimeOverride).toEqual(['anthropic', 'request-key']);
    } finally {
      if (originalExisting === undefined) delete process.env.OMP_PROVIDER_TEST_EXISTING;
      else process.env.OMP_PROVIDER_TEST_EXISTING = originalExisting;
      if (originalNew === undefined) delete process.env.OMP_PROVIDER_TEST_NEW;
      else process.env.OMP_PROVIDER_TEST_NEW = originalNew;
    }
  });

  test('does not apply config env when model validation fails', async () => {
    const originalNew = process.env.OMP_PROVIDER_TEST_INVALID_MODEL;
    delete process.env.OMP_PROVIDER_TEST_INVALID_MODEL;
    const provider = new OmpProvider(async () => makeSdk());

    try {
      await expect(async () => {
        await collectChunks(provider, {
          model: 'not-a-model-ref',
          assistantConfig: { env: { OMP_PROVIDER_TEST_INVALID_MODEL: 'configured' } },
        });
      }).toThrow('Invalid Oh My Pi model ref');
      expect(process.env.OMP_PROVIDER_TEST_INVALID_MODEL).toBeUndefined();
    } finally {
      if (originalNew === undefined) delete process.env.OMP_PROVIDER_TEST_INVALID_MODEL;
      else process.env.OMP_PROVIDER_TEST_INVALID_MODEL = originalNew;
    }
  });

  test('serializes overlapping config env sessions', async () => {
    const originalShared = process.env.OMP_PROVIDER_TEST_SHARED;
    delete process.env.OMP_PROVIDER_TEST_SHARED;

    let releaseFirst: (() => void) | undefined;
    let markFirstPromptEntered: (() => void) | undefined;
    const firstPromptEntered = new Promise<void>(resolve => {
      markFirstPromptEntered = resolve;
    });
    const providerOne = new OmpProvider(async () =>
      makeSdk({
        async onPrompt() {
          expect(process.env.OMP_PROVIDER_TEST_SHARED).toBe('first');
          markFirstPromptEntered?.();
          await new Promise<void>(release => {
            releaseFirst = release;
          });
        },
      })
    );
    const firstRun = collectChunks(providerOne, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { env: { OMP_PROVIDER_TEST_SHARED: 'first' } },
    });

    try {
      await firstPromptEntered;
      let secondPromptStarted = false;
      let secondPromptValue: string | undefined;
      const providerTwo = new OmpProvider(async () =>
        makeSdk({
          onPrompt() {
            secondPromptStarted = true;
            secondPromptValue = process.env.OMP_PROVIDER_TEST_SHARED;
          },
        })
      );

      const secondRun = collectChunks(providerTwo, {
        model: 'anthropic/claude-sonnet-4-5',
      });
      await Promise.resolve();
      expect(secondPromptStarted).toBe(false);

      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);

      expect(secondPromptStarted).toBe(true);
      expect(secondPromptValue).toBeUndefined();
      expect(process.env.OMP_PROVIDER_TEST_SHARED).toBeUndefined();
    } finally {
      releaseFirst?.();
      if (originalShared === undefined) delete process.env.OMP_PROVIDER_TEST_SHARED;
      else process.env.OMP_PROVIDER_TEST_SHARED = originalShared;
    }
  });

  test('passes hasUI true by default and binds UI context', async () => {
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    let boundHasUi: boolean | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
        onSetToolUIContext(_uiContext, hasUI) {
          boundHasUi = hasUI;
        },
      })
    );

    await collectChunks(provider, { model: 'anthropic/claude-sonnet-4-5' });

    expect(sessionOptions?.hasUI).toBe(true);
    expect(boundHasUi).toBe(true);
  });

  test('preserves OMP SDK discovery default when config omits disableExtensionDiscovery', async () => {
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
      })
    );

    await collectChunks(provider, { model: 'anthropic/claude-sonnet-4-5' });

    expect(sessionOptions?.disableExtensionDiscovery).toBeUndefined();
  });

  test('passes explicit extension discovery disable flag when configured', async () => {
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { disableExtensionDiscovery: true },
    });

    expect(sessionOptions?.disableExtensionDiscovery).toBe(true);
  });

  test('passes hasUI false and skips UI binding when interactive is false', async () => {
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    let uiBindCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
        onSetToolUIContext() {
          uiBindCount += 1;
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { interactive: false },
    });

    expect(sessionOptions?.hasUI).toBe(false);
    expect(uiBindCount).toBe(0);
  });

  test('applies extension flags before prompting when an extension runner exists', async () => {
    const events: string[] = [];
    const provider = new OmpProvider(async () =>
      makeSdk({
        extensionRunner: {
          setFlagValue(name, value) {
            events.push(`flag:${name}=${String(value)}`);
          },
        },
        onPrompt() {
          events.push('prompt');
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { extensionFlags: { plan: true, mode: 'strict' } },
    });

    expect(events).toEqual(['flag:plan=true', 'flag:mode=strict', 'prompt']);
  });

  test('warns when extension flags are configured but no extension runner exists', async () => {
    const provider = new OmpProvider(async () => makeSdk());

    const chunks = await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { extensionFlags: { plan: true } },
    });

    expect(chunks).toContainEqual({
      type: 'system',
      content: '⚠️ Oh My Pi ignored extensionFlags because no OMP extension runner was loaded.',
    });
  });
});

describe('augmentPromptForJsonSchema', () => {
  test('adds JSON-only instruction and schema', () => {
    const result = augmentPromptForJsonSchema('answer', { type: 'object' });
    expect(result).toContain('Respond with ONLY a JSON object');
    expect(result).toContain('"type": "object"');
  });
});
