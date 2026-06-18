import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  acquireConfigEnvLease,
  augmentPromptForJsonSchema,
  extensionFlagWarning,
  mcpEnvWarning,
  OmpProvider,
} from './provider';
import type {
  OmpAuthStorage,
  OmpCodingAgentSdk,
  OmpCreateAgentSessionOptions,
  OmpCreateAgentSessionResult,
  OmpExtensionRunner,
  OmpExtensionApi,
  OmpMcpManager,
  OmpMcpSourceMeta,
  OmpToolCallEvent,
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
  onGetApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  onModelRegistryRefresh?: () => void | Promise<void>;
  onFindModel?: (provider: string, modelId: string) => unknown;
  onModelRegistryGetApiKey?: (
    model: unknown,
    sessionId?: string
  ) => string | undefined | Promise<string | undefined>;
  onPrompt?: (session: FakeOmpSession) => void | Promise<void>;
  onDispose?: () => void | Promise<void>;
  mcpTools?: unknown[];
  mcpErrors?: Map<string, string>;
  mcpConnectError?: Error;
  onConnectMcp?: (args: {
    configs: Record<string, unknown>;
    sources: Record<string, OmpMcpSourceMeta>;
    manager: OmpMcpManager;
  }) => void;
  onDisconnectMcp?: () => void;
  disconnectMcpError?: Error;
  onSetMcpAuthStorage?: (authStorage: OmpAuthStorage) => void;
  returnSdkManagedMcpManager?: boolean;
  sessions?: Array<{ id: string; path: string }>;
  onForkSession?: (filePath: string, cwd: string, sessionDir?: string) => void;
  onOpenSession?: (filePath: string, sessionDir?: string) => void;
}

type OmpToolCallHandler = (event: OmpToolCallEvent) => void | Promise<void>;

interface FakeOmpSession extends OmpSession {
  emitToolCall(event: OmpToolCallEvent): Promise<void>;
}

async function collectChunks(
  provider: OmpProvider,
  options: Parameters<OmpProvider['sendQuery']>[3],
  cwd = '/repo'
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of provider.sendQuery('hi', cwd, undefined, options)) {
    chunks.push(chunk);
  }
  return chunks;
}

async function writeTempMcpConfig(config: Record<string, unknown>): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = join(
    tmpdir(),
    `omp-provider-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(config));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function makeSdk(options: FakeSdkOptions = {}): OmpCodingAgentSdk {
  let toolCallHandlers: OmpToolCallHandler[] = [];

  const session: FakeOmpSession = {
    sessionId: 'sess-1',
    ...(options.extensionRunner ? { extensionRunner: options.extensionRunner } : {}),
    subscribe(listener) {
      this.listener = listener;
      return () => undefined;
    },
    async emitToolCall(event) {
      for (const handler of toolCallHandlers) await handler(event);
    },
    async prompt() {
      await options.onPrompt?.(session);
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
      void options.onDispose?.();
      return undefined;
    },
  } as FakeOmpSession & { listener?: (event: unknown) => void };

  const authStorage: OmpAuthStorage = {
    setRuntimeApiKey(provider, apiKey) {
      options.onSetRuntimeApiKey?.(provider, apiKey);
    },
    async getApiKey(provider) {
      if (options.onGetApiKey) return await options.onGetApiKey(provider);
      return options.apiKey ?? 'sk-test';
    },
  };

  class FakeMcpManager implements OmpMcpManager {
    constructor(
      readonly cwd: string,
      readonly toolCache?: unknown
    ) {}

    setAuthStorage(authStorage: OmpAuthStorage): void {
      options.onSetMcpAuthStorage?.(authStorage);
    }

    async connectServers(
      configs: Record<string, unknown>,
      sources: Record<string, OmpMcpSourceMeta>
    ) {
      options.onConnectMcp?.({ configs, sources, manager: this });
      if (options.mcpConnectError) throw options.mcpConnectError;
      return {
        tools: options.mcpTools ?? [],
        errors: options.mcpErrors ?? new Map<string, string>(),
        connectedServers: Object.keys(configs).filter(name => !options.mcpErrors?.has(name)),
        exaApiKeys: [],
      };
    }

    async disconnectAll(): Promise<void> {
      options.onDisconnectMcp?.();
      if (options.disconnectMcpError) throw options.disconnectMcpError;
    }
  }

  return {
    MCPManager: FakeMcpManager,
    async createAgentSession(sessionOptions) {
      options.onCreateAgentSession?.(sessionOptions);
      toolCallHandlers = [];
      const extensionApi: OmpExtensionApi = {
        on(_event, handler) {
          toolCallHandlers.push(handler);
        },
      };
      for (const extension of sessionOptions.extensions ?? []) {
        await extension(extensionApi);
      }
      const result: OmpCreateAgentSessionResult = {
        session,
        setToolUIContext(uiContext, hasUI) {
          options.onSetToolUIContext?.(uiContext, hasUI);
        },
      };
      if (options.returnSdkManagedMcpManager) {
        result.mcpManager = new FakeMcpManager('/sdk-managed', null);
      }
      return result;
    },
    async discoverAuthStorage() {
      return authStorage;
    },
    ModelRegistry: class {
      async refresh(): Promise<void> {
        await options.onModelRegistryRefresh?.();
      }
      refreshInBackground(): void {
        return undefined;
      }
      async getApiKey(model: unknown, _sessionId?: string): Promise<string | undefined> {
        if (options.onModelRegistryGetApiKey) {
          return await options.onModelRegistryGetApiKey(model, _sessionId);
        }
        if (typeof model === 'object' && model !== null) {
          const provider = (model as { provider?: unknown }).provider;
          if (typeof provider === 'string' && options.onGetApiKey) {
            return await options.onGetApiKey(provider);
          }
        }
        return options.apiKey ?? 'sk-test';
      }
      find(provider: string, modelId: string): unknown {
        if (options.onFindModel) return options.onFindModel(provider, modelId);
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
        return options.sessions ?? [];
      },
      async open(filePath: string, sessionDir?: string) {
        options.onOpenSession?.(filePath, sessionDir);
        return {};
      },
      async forkFrom(filePath: string, cwd: string, sessionDir?: string) {
        options.onForkSession?.(filePath, cwd, sessionDir);
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
    expect(provider.getCapabilities().envInjection).toBe(true);
    expect(provider.getCapabilities().fallbackModel).toBe(true);
  });

  test('throws on missing model', async () => {
    const provider = new OmpProvider(async () => makeSdk());
    await expect(async () => {
      for await (const _chunk of provider.sendQuery('hi', '/repo')) {
        // consume
      }
    }).toThrow('requires a model');
  });

  test('awaits model registry refresh before finding requested model', async () => {
    let refreshCompleted = false;
    const provider = new OmpProvider(async () =>
      makeSdk({
        async onModelRegistryRefresh() {
          await new Promise(resolve => setTimeout(resolve, 0));
          refreshCompleted = true;
        },
        onFindModel(providerName, modelId) {
          expect(refreshCompleted).toBe(true);
          return { provider: providerName, id: modelId };
        },
      })
    );

    await collectChunks(provider, { model: 'custom/model-one' });
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

  test('forks resumed sessions when executor requests forkSession', async () => {
    const forkCalls: Array<{ filePath: string; cwd: string; sessionDir?: string }> = [];
    const openCalls: Array<{ filePath: string; sessionDir?: string }> = [];
    const provider = new OmpProvider(async () =>
      makeSdk({
        sessions: [{ id: 'sess-prev', path: '/sessions/sess-prev.jsonl' }],
        onForkSession(filePath, cwd, sessionDir) {
          forkCalls.push({ filePath, cwd, sessionDir });
        },
        onOpenSession(filePath, sessionDir) {
          openCalls.push({ filePath, sessionDir });
        },
      })
    );

    const chunks: MessageChunk[] = [];
    for await (const chunk of provider.sendQuery('hi', '/repo', 'sess-prev', {
      model: 'anthropic/claude-sonnet-4-5',
      forkSession: true,
    })) {
      chunks.push(chunk);
    }

    expect(forkCalls).toEqual([
      {
        filePath: '/sessions/sess-prev.jsonl',
        cwd: '/repo',
        sessionDir: undefined,
      },
    ]);
    expect(openCalls).toEqual([]);
    expect(chunks.at(-1)?.type).toBe('result');
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
          retry: {
            enabled: false,
            maxRetries: 2,
            fallbackChains: { default: ['openrouter/qwen/qwen3-coder'] },
            fallbackRevertPolicy: 'never',
          },
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
      'retry.fallbackChains': { default: ['openrouter/qwen/qwen3-coder'] },
      'retry.fallbackRevertPolicy': 'never',
      'compaction.enabled': true,
      'contextPromotion.enabled': false,
      modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
      enabledModels: ['anthropic/*'],
      modelProviderOrder: ['anthropic'],
      disabledProviders: ['experimental-provider'],
      disabledExtensions: ['risky-extension'],
    });
  });

  test('does not add OMP retry fallback overrides without fallbackModel', async () => {
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
    });

    expect(settingsOverrides).toEqual({});
  });

  test('maps fallbackModel to OMP retry fallback chain settings', async () => {
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
      fallbackModel: 'openrouter/qwen/qwen3-coder',
    });

    expect(settingsOverrides).toEqual({
      'retry.fallbackChains': { archon: ['openrouter/qwen/qwen3-coder'] },
      modelRoles: { archon: 'anthropic/claude-sonnet-4-5' },
    });
  });

  test('passes fallback provider runtime auth override', async () => {
    const runtimeOverrides: Array<[string, string]> = [];
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSetRuntimeApiKey(providerName, apiKey) {
          runtimeOverrides.push([providerName, apiKey]);
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      fallbackModel: 'openrouter/qwen/qwen3-coder',
      env: {
        ANTHROPIC_API_KEY: 'anthropic-request-key',
        OPENROUTER_API_KEY: 'openrouter-request-key',
      },
    });

    expect(runtimeOverrides).toEqual([
      ['anthropic', 'anthropic-request-key'],
      ['openrouter', 'openrouter-request-key'],
    ]);
  });

  test('merges fallbackModel with explicit OMP retry fallback settings', async () => {
    let settingsOverrides: Record<string, unknown> | undefined;
    const resolvedModels = new Map([
      ['anthropic/claude-sonnet-4-5', { provider: 'anthropic', id: 'claude-sonnet-4-5' }],
      ['openrouter/qwen/qwen3-coder', { provider: 'openrouter', id: 'qwen/qwen3-coder' }],
    ]);
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSettingsIsolated(overrides) {
          settingsOverrides = overrides;
        },
        onFindModel(providerName, modelId) {
          return resolvedModels.get(`${providerName}/${modelId}`);
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      fallbackModel: 'openrouter/qwen/qwen3-coder:off',
      assistantConfig: {
        settings: {
          retry: {
            enabled: true,
            fallbackChains: { default: ['anthropic/claude-opus-4-5'] },
            fallbackRevertPolicy: 'never',
          },
          modelRoles: { default: 'anthropic/claude-sonnet-4-5' },
        },
      },
    });

    expect(settingsOverrides).toEqual({
      'retry.enabled': true,
      'retry.fallbackChains': {
        archon: ['openrouter/qwen/qwen3-coder:off'],
        default: ['anthropic/claude-opus-4-5'],
      },
      'retry.fallbackRevertPolicy': 'never',
      modelRoles: {
        archon: 'anthropic/claude-sonnet-4-5',
        default: 'anthropic/claude-sonnet-4-5',
      },
    });
    expect(Object.keys(settingsOverrides?.['retry.fallbackChains'] ?? {})).toEqual([
      'archon',
      'default',
    ]);
  });

  test('rejects explicit OMP archon fallback role collisions', async () => {
    const provider = new OmpProvider(async () => makeSdk());

    await expect(async () => {
      await collectChunks(provider, {
        model: 'anthropic/claude-sonnet-4-5',
        fallbackModel: 'openrouter/qwen/qwen3-coder',
        assistantConfig: {
          settings: {
            modelRoles: { archon: 'anthropic/claude-opus-4-5' },
          },
        },
      });
    }).toThrow('settings.modelRoles.archon');

    await expect(async () => {
      await collectChunks(provider, {
        model: 'anthropic/claude-sonnet-4-5',
        fallbackModel: 'openrouter/qwen/qwen3-coder',
        assistantConfig: {
          settings: {
            retry: { fallbackChains: { archon: ['anthropic/claude-opus-4-5'] } },
          },
        },
      });
    }).toThrow('settings.retry.fallbackChains.archon');
  });
  test('rejects invalid OMP fallback model refs before creating a session', async () => {
    let createCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession() {
          createCount += 1;
        },
      })
    );

    await expect(async () => {
      await collectChunks(provider, {
        model: 'anthropic/claude-sonnet-4-5',
        fallbackModel: 'claude-haiku-4-5',
      });
    }).toThrow('Invalid Oh My Pi fallback model ref');
    expect(createCount).toBe(0);
  });

  test('rejects unknown OMP fallback models before creating a session', async () => {
    let createCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onFindModel(providerName, modelId) {
          if (providerName === 'anthropic' && modelId === 'claude-sonnet-4-5') {
            return { provider: providerName, id: modelId };
          }
          return undefined;
        },
        onCreateAgentSession() {
          createCount += 1;
        },
      })
    );

    await expect(async () => {
      await collectChunks(provider, {
        model: 'anthropic/claude-sonnet-4-5',
        fallbackModel: 'openrouter/qwen/qwen3-coder',
      });
    }).toThrow('Oh My Pi fallback model not found');
    expect(createCount).toBe(0);
  });

  test('rejects fallback models without usable auth before creating a session', async () => {
    let createCount = 0;
    const fallbackModelInstance = { provider: 'openrouter', id: 'qwen/qwen3-coder' };
    const provider = new OmpProvider(async () =>
      makeSdk({
        onFindModel(providerName, modelId) {
          if (providerName === 'anthropic' && modelId === 'claude-sonnet-4-5') {
            return { provider: providerName, id: modelId };
          }
          if (providerName === 'openrouter' && modelId === 'qwen/qwen3-coder') {
            return fallbackModelInstance;
          }
          return undefined;
        },
        onModelRegistryGetApiKey(model) {
          return model === fallbackModelInstance ? undefined : 'sk-test';
        },
        onCreateAgentSession() {
          createCount += 1;
        },
      })
    );

    await expect(async () => {
      await collectChunks(provider, {
        model: 'anthropic/claude-sonnet-4-5',
        fallbackModel: 'openrouter/qwen/qwen3-coder',
      });
    }).toThrow('Oh My Pi fallback model has no usable auth');
    expect(createCount).toBe(0);
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

  test('ANTHROPIC_OAUTH_TOKEN routes into setRuntimeApiKey for anthropic (#1984)', async () => {
    let runtimeOverride: [string, string] | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSetRuntimeApiKey(providerName, apiKey) {
          runtimeOverride = [providerName, apiKey];
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: { ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-bearer' },
    });

    expect(runtimeOverride).toEqual(['anthropic', 'sk-ant-oat01-bearer']);
  });

  test('CLAUDE_CODE_OAUTH_TOKEN routes into setRuntimeApiKey for anthropic', async () => {
    let runtimeOverride: [string, string] | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSetRuntimeApiKey(providerName, apiKey) {
          runtimeOverride = [providerName, apiKey];
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-claude-code' },
    });

    expect(runtimeOverride).toEqual(['anthropic', 'sk-ant-oat01-claude-code']);
  });

  test('OAuth var wins over API-key var for anthropic (#1984)', async () => {
    let runtimeOverride: [string, string] | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSetRuntimeApiKey(providerName, apiKey) {
          runtimeOverride = [providerName, apiKey];
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: {
        ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-bearer',
        ANTHROPIC_API_KEY: 'sk-ant-apikey',
      },
    });

    expect(runtimeOverride).toEqual(['anthropic', 'sk-ant-oat01-bearer']);
  });

  test('injects request env into OMP bash tool calls', async () => {
    let bashArgs: Record<string, unknown> | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        async onPrompt(session) {
          bashArgs = { command: 'echo $DATABASE_URL' };
          await session.emitToolCall({
            toolName: 'bash',
            toolCallId: 'tool-1',
            input: bashArgs,
          });
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: { DATABASE_URL: 'postgres://managed', API_TOKEN: 'secret' },
    });

    expect(bashArgs?.env).toEqual({
      DATABASE_URL: 'postgres://managed',
      API_TOKEN: 'secret',
    });
  });

  test('lets explicit OMP bash env override injected request env', async () => {
    let bashArgs: Record<string, unknown> | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        async onPrompt(session) {
          bashArgs = {
            command: 'echo $DATABASE_URL',
            env: { DATABASE_URL: 'postgres://tool', PATH: '/bin' },
          };
          await session.emitToolCall({
            toolName: 'bash',
            toolCallId: 'tool-1',
            input: bashArgs,
          });
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: { DATABASE_URL: 'postgres://managed', API_TOKEN: 'secret' },
    });

    expect(bashArgs?.env).toEqual({
      DATABASE_URL: 'postgres://tool',
      API_TOKEN: 'secret',
      PATH: '/bin',
    });
  });

  test('does not inject assistant config env into OMP bash tool calls', async () => {
    let bashArgs: Record<string, unknown> | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        async onPrompt(session) {
          bashArgs = { command: 'echo $OMP_CONFIG_ONLY $REQUEST_ONLY' };
          await session.emitToolCall({
            toolName: 'bash',
            toolCallId: 'tool-1',
            input: bashArgs,
          });
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: { REQUEST_ONLY: 'request-value' },
      assistantConfig: { env: { OMP_CONFIG_ONLY: 'config-value' } },
    });

    expect(bashArgs?.env).toEqual({ REQUEST_ONLY: 'request-value' });
  });

  test('does not inject request env into non-bash tool calls', async () => {
    let readInput: Record<string, unknown> | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        async onPrompt(session) {
          readInput = { path: 'original.txt' };
          await session.emitToolCall({
            toolName: 'read',
            toolCallId: 'tool-1',
            input: readInput,
          });
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      env: { TOKEN: 'managed' },
    });

    expect(readInput).toEqual({ path: 'original.txt' });
  });

  test('uses assistant config env for runtime auth override', async () => {
    let runtimeOverride: [string, string] | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSetRuntimeApiKey(providerName, apiKey) {
          runtimeOverride = [providerName, apiKey];
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { env: { ANTHROPIC_API_KEY: 'config-key' } },
    });

    expect(runtimeOverride).toEqual(['anthropic', 'config-key']);
  });

  test('applies assistant config env for custom providers without requiring auth keys', async () => {
    const originalCustomKey = process.env.CUSTOM_OMP_PROVIDER_API_KEY;
    delete process.env.CUSTOM_OMP_PROVIDER_API_KEY;
    const observedEnvValues: Array<string | undefined> = [];
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession() {
          observedEnvValues.push(process.env.CUSTOM_OMP_PROVIDER_API_KEY);
        },
        onGetApiKey(providerName) {
          if (providerName !== 'custom') return 'sk-test';
          return undefined;
        },
      })
    );

    try {
      await collectChunks(provider, {
        model: 'custom/model-one',
        assistantConfig: { env: { CUSTOM_OMP_PROVIDER_API_KEY: 'config-key' } },
      });

      expect(observedEnvValues).toEqual(['config-key']);
      expect(process.env.CUSTOM_OMP_PROVIDER_API_KEY).toBeUndefined();
    } finally {
      if (originalCustomKey === undefined) delete process.env.CUSTOM_OMP_PROVIDER_API_KEY;
      else process.env.CUSTOM_OMP_PROVIDER_API_KEY = originalCustomKey;
    }
  });

  test('does not require an API key before creating local provider sessions', async () => {
    let created = false;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onGetApiKey(providerName) {
          if (providerName !== 'local') return 'sk-test';
          return undefined;
        },
        onCreateAgentSession() {
          created = true;
        },
      })
    );

    await collectChunks(provider, { model: 'local/model-one' });

    expect(created).toBe(true);
  });

  test('prefers shell auth env over assistant config env', async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'shell-key';
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
        assistantConfig: { env: { ANTHROPIC_API_KEY: 'config-key' } },
      });

      expect(runtimeOverride).toEqual(['anthropic', 'shell-key']);
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
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
      let resolveSecondPromptEntered: (() => void) | undefined;
      const secondPromptEntered = new Promise<void>(resolve => {
        resolveSecondPromptEntered = resolve;
      });
      const providerTwo = new OmpProvider(async () =>
        makeSdk({
          onPrompt() {
            secondPromptStarted = true;
            secondPromptValue = process.env.OMP_PROVIDER_TEST_SHARED;
            resolveSecondPromptEntered?.();
          },
        })
      );

      const secondRun = collectChunks(providerTwo, {
        model: 'anthropic/claude-sonnet-4-5',
      });
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

  test('does not serialize overlapping sessions without config env', async () => {
    let releaseFirst: (() => void) | undefined;
    let markFirstPromptEntered: (() => void) | undefined;
    const firstPromptEntered = new Promise<void>(resolve => {
      markFirstPromptEntered = resolve;
    });
    const providerOne = new OmpProvider(async () =>
      makeSdk({
        async onPrompt() {
          markFirstPromptEntered?.();
          await new Promise<void>(release => {
            releaseFirst = release;
          });
        },
      })
    );
    const firstRun = collectChunks(providerOne, {
      model: 'anthropic/claude-sonnet-4-5',
    });

    try {
      await firstPromptEntered;
      let secondPromptStarted = false;
      let resolveSecondPromptEntered: (() => void) | undefined;
      const secondPromptEntered = new Promise<void>(resolve => {
        resolveSecondPromptEntered = resolve;
      });
      const providerTwo = new OmpProvider(async () =>
        makeSdk({
          onPrompt() {
            secondPromptStarted = true;
            resolveSecondPromptEntered?.();
          },
        })
      );

      const secondRun = collectChunks(providerTwo, {
        model: 'anthropic/claude-sonnet-4-5',
      });
      await secondPromptEntered;

      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);
    } finally {
      releaseFirst?.();
    }
  });

  test('writer config-env lease blocks readers until released', async () => {
    const releaseWriter = await acquireConfigEnvLease(true);
    let readerAcquired = false;

    const readerLease = acquireConfigEnvLease(false).then(releaseReader => {
      readerAcquired = true;
      return releaseReader;
    });
    await Promise.resolve();
    expect(readerAcquired).toBe(false);

    releaseWriter();
    const releaseReader = await readerLease;
    expect(readerAcquired).toBe(true);

    releaseReader();
    releaseReader();
  });

  test('aborts queued config-env lease acquisition', async () => {
    const releaseWriter = await acquireConfigEnvLease(true);
    const controller = new AbortController();
    const waitingLease = acquireConfigEnvLease(true, controller.signal);

    controller.abort();

    await expect(waitingLease).rejects.toThrow(
      'Oh My Pi request aborted while waiting for config env lease.'
    );

    releaseWriter();
  });

  test('extension flag warning only appears when flags cannot be applied', () => {
    expect(extensionFlagWarning(false, false)).toBeUndefined();
    expect(extensionFlagWarning(true, true)).toBeUndefined();
    expect(extensionFlagWarning(true, false)).toBe(
      '⚠️ Oh My Pi ignored extensionFlags because no OMP extension runner was loaded.'
    );
  });

  test('MCP env warning deduplicates missing variables', () => {
    expect(mcpEnvWarning([])).toBeUndefined();
    expect(mcpEnvWarning(['TOKEN', 'TOKEN', 'OTHER'])).toBe(
      '⚠️ MCP config references undefined env vars: TOKEN, OTHER. These will be empty strings — MCP servers may fail to authenticate.'
    );
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

  test('passes custom system prompt as ordered block array', async () => {
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
      systemPrompt: 'request-level wins',
      nodeConfig: { systemPrompt: 'node-level prompt' },
    });

    expect(sessionOptions?.systemPrompt).toEqual(['request-level wins']);
  });

  test('passes system prompt string array without nesting', async () => {
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
      systemPrompt: ['block one', 'block two'],
    });

    expect(sessionOptions?.systemPrompt).toEqual(['block one', 'block two']);
  });

  test('drops non-string system prompt presets because OMP only accepts prompt blocks', async () => {
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
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' },
    });

    expect(sessionOptions?.systemPrompt).toBeUndefined();
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

  test('disposes session when consumer cancels after a pre-bridge warning', async () => {
    let disposeCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onDispose() {
          disposeCount += 1;
        },
      })
    );

    const chunks = provider.sendQuery('hi', '/repo', undefined, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { extensionFlags: { plan: true } },
    });

    await expect(chunks.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'system',
        content: '⚠️ Oh My Pi ignored extensionFlags because no OMP extension runner was loaded.',
      },
    });

    await chunks.return(undefined as never);

    expect(disposeCount).toBe(1);
  });

  test('passes workflow mcp config through OMP MCP manager', async () => {
    const temp = await writeTempMcpConfig({
      github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
    });
    let connectArgs: Parameters<NonNullable<FakeSdkOptions['onConnectMcp']>>[0] | undefined;
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    let disconnectCount = 0;
    const mcpTool = { name: 'mcp__github_create_issue' };
    const provider = new OmpProvider(async () =>
      makeSdk({
        mcpTools: [mcpTool],
        onConnectMcp(args) {
          connectArgs = args;
        },
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
        onDisconnectMcp() {
          disconnectCount += 1;
        },
      })
    );

    try {
      await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
          assistantConfig: { enableMCP: false },
        },
        temp.dir
      );

      expect(connectArgs?.configs).toEqual({
        github: { command: 'npx', args: ['-y', '@mcp/server-github'] },
      });
      expect(connectArgs?.sources.github).toEqual({
        provider: 'archon',
        providerName: 'Archon workflow mcp',
        path: join(temp.dir, 'mcp.json'),
        level: 'project',
      });
      expect(sessionOptions?.enableMCP).toBe(true);
      expect(sessionOptions?.mcpManager).toBe(connectArgs?.manager);
      expect(sessionOptions?.customTools).toEqual([mcpTool]);
      expect(disconnectCount).toBe(1);
      expect(connectArgs?.manager).toBeDefined();
    } finally {
      await temp.cleanup();
    }
  });

  test('wires OMP auth storage into workflow MCP manager', async () => {
    const temp = await writeTempMcpConfig({
      github: {
        type: 'http',
        url: 'https://mcp.example.com',
        auth: { type: 'oauth', credentialId: 'github-oauth' },
      },
    });
    let mcpAuthStorage: OmpAuthStorage | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onSetMcpAuthStorage(authStorage) {
          mcpAuthStorage = authStorage;
        },
      })
    );

    try {
      await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
        },
        temp.dir
      );

      expect(mcpAuthStorage).toBeDefined();
      if (!mcpAuthStorage) throw new Error('MCP auth storage was not wired');
      await expect(mcpAuthStorage.getApiKey('anthropic')).resolves.toBe('sk-test');
    } finally {
      await temp.cleanup();
    }
  });
  test('adds loaded MCP tool names to OMP toolNames allowlist', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    const provider = new OmpProvider(async () =>
      makeSdk({
        mcpTools: [{ name: 'mcp__github_create_issue' }],
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
      })
    );

    try {
      await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json', allowed_tools: ['read'] },
        },
        temp.dir
      );

      expect(sessionOptions?.toolNames).toEqual(['read', 'mcp__github_create_issue']);
    } finally {
      await temp.cleanup();
    }
  });

  test('filters denied loaded MCP tools from allowlist and custom tools', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    let sessionOptions: OmpCreateAgentSessionOptions | undefined;
    const deniedTool = { name: 'mcp__github_create_issue' };
    const allowedTool = { name: 'mcp__github_list_issues' };
    const provider = new OmpProvider(async () =>
      makeSdk({
        mcpTools: [deniedTool, allowedTool],
        onCreateAgentSession(options) {
          sessionOptions = options;
        },
      })
    );

    try {
      await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: {
            mcp: 'mcp.json',
            allowed_tools: ['read'],
            denied_tools: ['mcp__github_create_issue'],
          },
        },
        temp.dir
      );

      expect(sessionOptions?.toolNames).toEqual(['read', 'mcp__github_list_issues']);
      expect(sessionOptions?.customTools).toEqual([allowedTool]);
    } finally {
      await temp.cleanup();
    }
  });
  test('surfaces missing MCP env vars', async () => {
    delete process.env.MISSING_OMP_MCP_TOKEN;
    const temp = await writeTempMcpConfig({
      github: { command: 'npx', env: { GITHUB_TOKEN: '$MISSING_OMP_MCP_TOKEN' } },
    });
    const provider = new OmpProvider(async () => makeSdk());

    try {
      const chunks = await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
        },
        temp.dir
      );

      expect(chunks).toContainEqual({
        type: 'system',
        content:
          '⚠️ MCP config references undefined env vars: MISSING_OMP_MCP_TOKEN. These will be empty strings — MCP servers may fail to authenticate.',
      });
    } finally {
      await temp.cleanup();
    }
  });

  test('expands MCP env vars from OMP config env inside the session lock', async () => {
    const temp = await writeTempMcpConfig({
      github: { command: 'npx', env: { GITHUB_TOKEN: '$OMP_PROVIDER_MCP_TOKEN' } },
    });
    let connectArgs: Parameters<NonNullable<FakeSdkOptions['onConnectMcp']>>[0] | undefined;
    const originalToken = process.env.OMP_PROVIDER_MCP_TOKEN;
    delete process.env.OMP_PROVIDER_MCP_TOKEN;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onConnectMcp(args) {
          connectArgs = args;
        },
      })
    );

    try {
      await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
          assistantConfig: { env: { OMP_PROVIDER_MCP_TOKEN: 'configured-token' } },
        },
        temp.dir
      );

      expect(connectArgs?.configs).toEqual({
        github: { command: 'npx', env: { GITHUB_TOKEN: 'configured-token' } },
      });
      expect(process.env.OMP_PROVIDER_MCP_TOKEN).toBeUndefined();
    } finally {
      await temp.cleanup();
      if (originalToken === undefined) delete process.env.OMP_PROVIDER_MCP_TOKEN;
      else process.env.OMP_PROVIDER_MCP_TOKEN = originalToken;
    }
  });

  test('expands MCP env vars from request env', async () => {
    const temp = await writeTempMcpConfig({
      github: { command: 'npx', env: { GITHUB_TOKEN: '$OMP_REQUEST_MCP_TOKEN' } },
    });
    let connectArgs: Parameters<NonNullable<FakeSdkOptions['onConnectMcp']>>[0] | undefined;
    const originalToken = process.env.OMP_REQUEST_MCP_TOKEN;
    delete process.env.OMP_REQUEST_MCP_TOKEN;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onConnectMcp(args) {
          connectArgs = args;
        },
      })
    );

    try {
      const chunks = await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
          env: { OMP_REQUEST_MCP_TOKEN: 'request-token' },
        },
        temp.dir
      );

      expect(connectArgs?.configs).toEqual({
        github: { command: 'npx', env: { GITHUB_TOKEN: 'request-token' } },
      });
      expect(chunks).not.toContainEqual({
        type: 'system',
        content:
          '⚠️ MCP config references undefined env vars: OMP_REQUEST_MCP_TOKEN. These will be empty strings — MCP servers may fail to authenticate.',
      });
    } finally {
      await temp.cleanup();
      if (originalToken === undefined) delete process.env.OMP_REQUEST_MCP_TOKEN;
      else process.env.OMP_REQUEST_MCP_TOKEN = originalToken;
    }
  });

  test('disconnects workflow MCP manager when MCP bootstrap fails', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    let disconnectCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        mcpConnectError: new Error('bootstrap failed'),
        onDisconnectMcp() {
          disconnectCount += 1;
        },
      })
    );

    try {
      await expect(
        collectChunks(
          provider,
          {
            model: 'anthropic/claude-sonnet-4-5',
            nodeConfig: { mcp: 'mcp.json' },
          },
          temp.dir
        )
      ).rejects.toThrow('bootstrap failed');
      expect(disconnectCount).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });

  test('fails when MCP teardown fails after a successful prompt', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    const provider = new OmpProvider(async () =>
      makeSdk({
        mcpTools: [{ name: 'mcp__github_create_issue' }],
        disconnectMcpError: new Error('disconnect failed'),
      })
    );

    try {
      await expect(
        collectChunks(
          provider,
          {
            model: 'anthropic/claude-sonnet-4-5',
            nodeConfig: { mcp: 'mcp.json' },
          },
          temp.dir
        )
      ).rejects.toThrow('Oh My Pi MCP teardown failed: disconnect failed');
    } finally {
      await temp.cleanup();
    }
  });

  test('preserves bootstrap failure when MCP cleanup also fails', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    const provider = new OmpProvider(async () =>
      makeSdk({
        mcpConnectError: new Error('bootstrap failed'),
        disconnectMcpError: new Error('disconnect failed'),
      })
    );

    try {
      const error = await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
        },
        temp.dir
      ).then(
        () => undefined,
        err => err
      );

      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe('Oh My Pi MCP bootstrap failed and cleanup also failed.');
      expect(
        aggregate.errors.map(item => (item instanceof Error ? item.message : String(item)))
      ).toEqual(['bootstrap failed', 'Oh My Pi MCP teardown failed: disconnect failed']);
    } finally {
      await temp.cleanup();
    }
  });

  test('reports per-server MCP connection failures with executor-compatible prefix', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    const provider = new OmpProvider(async () =>
      makeSdk({ mcpErrors: new Map([['github', 'connect failed']]) })
    );

    try {
      const chunks = await collectChunks(
        provider,
        {
          model: 'anthropic/claude-sonnet-4-5',
          nodeConfig: { mcp: 'mcp.json' },
        },
        temp.dir
      );

      expect(
        chunks.some(
          chunk =>
            chunk.type === 'system' &&
            chunk.content.startsWith('MCP server connection failed: github')
        )
      ).toBe(true);
    } finally {
      await temp.cleanup();
    }
  });

  test('disconnects workflow MCP manager when session creation fails', async () => {
    const temp = await writeTempMcpConfig({ github: { command: 'npx' } });
    let disconnectCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        onCreateAgentSession() {
          throw new Error('session failed');
        },
        onDisconnectMcp() {
          disconnectCount += 1;
        },
      })
    );

    try {
      await expect(
        collectChunks(
          provider,
          {
            model: 'anthropic/claude-sonnet-4-5',
            nodeConfig: { mcp: 'mcp.json' },
          },
          temp.dir
        )
      ).rejects.toThrow('session failed');
      expect(disconnectCount).toBe(1);
    } finally {
      await temp.cleanup();
    }
  });
  test('does not enable broad OMP discovery when no node mcp is configured', async () => {
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
      assistantConfig: { enableMCP: false },
    });

    expect(sessionOptions?.enableMCP).toBe(false);
    expect(sessionOptions?.mcpManager).toBeUndefined();
    expect(sessionOptions?.customTools).toBeUndefined();
  });

  test('preserves broad OMP discovery when enabled and no node mcp is configured', async () => {
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
      assistantConfig: { enableMCP: true },
    });

    expect(sessionOptions?.enableMCP).toBe(true);
    expect(sessionOptions?.mcpManager).toBeUndefined();
    expect(sessionOptions?.customTools).toBeUndefined();
  });

  test('disconnects SDK-managed MCP manager when broad OMP discovery is enabled', async () => {
    let disconnectCount = 0;
    const provider = new OmpProvider(async () =>
      makeSdk({
        returnSdkManagedMcpManager: true,
        onDisconnectMcp() {
          disconnectCount += 1;
        },
      })
    );

    await collectChunks(provider, {
      model: 'anthropic/claude-sonnet-4-5',
      assistantConfig: { enableMCP: true },
    });

    expect(disconnectCount).toBe(1);
  });
  test('reports capabilities mcp true', () => {
    const provider = new OmpProvider(async () => makeSdk());

    expect(provider.getCapabilities().mcp).toBe(true);
  });
});

describe('augmentPromptForJsonSchema', () => {
  test('adds JSON-only instruction and schema', () => {
    const result = augmentPromptForJsonSchema('answer', {
      type: 'array',
      items: { type: 'string' },
    });
    expect(result).toContain('Respond with ONLY valid JSON matching the schema below');
    expect(result).toContain('"type": "array"');
  });
});
