// Each consumer runs in a separate test group: these SDK mocks and Pi caches are process-wide.
import { PI_PROVIDER_ENV_VARS } from './pi-vendor-map.generated';
import { beforeEach, mock } from 'bun:test';
import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ExtensionProviderRegistration } from './resource-loader';
import { createMockLogger } from '../../test/mocks/logger';
import { resetReloadedExtensionLoaderCache } from './resource-loader';

export const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  BUNDLED_VERSION: 'test',
  createLogger: mock(() => mockLogger),
}));

// Use Pi's event union so SDK changes also check the scripted events.
export type FakeEvent = AgentSessionEvent;
export let capturedListener: ((event: FakeEvent) => void) | undefined;

export const scriptedEvents: FakeEvent[] = [];
export const mockPrompt = mock(async (_prompt: string): Promise<void> => {
  for (const ev of scriptedEvents) capturedListener?.(ev);
});
export const mockAbort = mock(async () => undefined);
export const mockDispose = mock(() => undefined);
const mockSubscribe = mock((listener: (event: FakeEvent) => void) => {
  capturedListener = listener;
  return () => {
    capturedListener = undefined;
  };
});

export const mockBindExtensions = mock(async (_bindings: unknown) => undefined);
export const mockSetFlagValue = mock((_name: string, _value: boolean | string) => undefined);
const mockExtensionRunner = {
  setFlagValue: mockSetFlagValue,
};
export const mockSetModel = mock(async (_model: unknown) => undefined);
const mockSession = {
  subscribe: mockSubscribe,
  prompt: mockPrompt,
  abort: mockAbort,
  dispose: mockDispose,
  bindExtensions: mockBindExtensions,
  extensionRunner: mockExtensionRunner,
  setModel: mockSetModel,
  getAllTools: () => [],
  getToolDefinition: () => undefined,
  setActiveToolsByName: (_toolNames: string[]) => undefined,
  agent: {},
  isStreaming: false,
  sessionId: 'mock-session-uuid',
};

export function createMockSessionResult(modelFallbackMessage?: string): CreateAgentSessionResult {
  return {
    session: mockSession,
    extensionsResult: { extensions: [], errors: [], runtime: {} },
    modelFallbackMessage,
  } as unknown as CreateAgentSessionResult;
}

export const mockCreateAgentSession = mock<
  typeof import('@earendil-works/pi-coding-agent').createAgentSession
>(
  async (_options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> =>
    createMockSessionResult()
);

export let fileCreds: Record<
  string,
  { type: 'api_key' | 'oauth'; key?: string; env?: Record<string, string> }
> = {};
export let runtimeOverrides: Record<string, string> = {};

export const mockSetRuntimeApiKey = mock<ModelRuntime['setRuntimeApiKey']>(
  async (providerId, key) => {
    runtimeOverrides[providerId] = key;
  }
);
export const mockGetAuth = mock(
  async (
    provider: string | Parameters<ModelRuntime['getAuth']>[0],
    _overrides?: Parameters<ModelRuntime['getAuth']>[1]
  ): ReturnType<ModelRuntime['getAuth']> => {
    const providerId = typeof provider === 'string' ? provider : provider.provider;
    if (runtimeOverrides[providerId]) {
      return { auth: { apiKey: runtimeOverrides[providerId] }, source: 'runtime-override' };
    }
    const cred = fileCreds[providerId];
    if (cred?.type === 'api_key') return { auth: { apiKey: cred.key }, source: 'auth.json' };
    if (cred?.type === 'oauth')
      return { auth: { apiKey: 'sk-ant-oat01-file-stub' }, source: 'auth.json' };
    return undefined;
  }
);
export const mockCheckAuth = mock<ModelRuntime['checkAuth']>(async providerId => {
  if (runtimeOverrides[providerId]) return { type: 'api_key', source: 'runtime override' };
  if (fileCreds[providerId])
    return { type: fileCreds[providerId].type, source: 'stored credential' };
  if (!PI_PROVIDER_ENV_VARS[providerId] && mockHasConfiguredAuth(providerId))
    return { type: 'api_key', source: 'config' };
  return undefined;
});
export const mockHasConfiguredAuth = mock<ModelRuntime['hasConfiguredAuth']>(
  providerId => runtimeOverrides[providerId] !== undefined || fileCreds[providerId] !== undefined
);

export function createMockModel(provider: string, modelId: string): Model<Api> {
  return {
    id: modelId,
    provider,
    name: `${provider}/${modelId}`,
    api: 'openai-completions',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

export const mockModelRegistryFind = mock<ModelRegistry['find']>((provider, modelId) => {
  if (provider === 'nonexistent') return undefined;
  return createMockModel(provider, modelId);
});

const mockModelRegistryGetProvider = mock<ModelRegistry['getProvider']>(provider =>
  provider === 'nonexistent'
    ? undefined
    : ({ id: provider, name: provider } as NonNullable<ReturnType<ModelRegistry['getProvider']>>)
);
export type MockModelRegistry = Pick<ModelRegistry, 'find'> &
  Partial<
    Pick<
      ModelRegistry,
      'getApiKeyAndHeaders' | 'getError' | 'hasConfiguredAuth' | 'registerProvider' | 'getProvider'
    >
  > & {
    /** Per-registry extension provider registrations, for assertions. */
    registered?: Map<string, unknown>;
  };

export type MockModelRuntime = Pick<
  ModelRuntime,
  | 'checkAuth'
  | 'getModels'
  | 'setRuntimeApiKey'
  | 'getAuth'
  | 'hasConfiguredAuth'
  | 'getProviderAuthStatus'
  | 'listCredentials'
>;
function makeMockRegistry(runtime: MockModelRuntime): MockModelRegistry {
  return {
    find: mockModelRegistryFind,

    getProvider: mockModelRegistryGetProvider,
    hasConfiguredAuth: mock(model => runtime.hasConfiguredAuth(model.provider)),
    getApiKeyAndHeaders: mock(async model => {
      const resolution = await runtime.getAuth(model.provider);
      return {
        ok: true as const,
        apiKey: resolution?.auth.apiKey,
        env: fileCreds[model.provider]?.env,
      };
    }),

    registerProvider: ((name: string, config: unknown) => {
      mockRegistryRegistered.set(name, config);
    }) as ModelRegistry['registerProvider'],
    registered: mockRegistryRegistered,
  };
}

/** Per-registry provider registration map for the most-recent registry. */
const mockRegistryRegistered = new Map<string, unknown>();

// Return an object explicitly: Bun mock constructors do not reliably preserve `this`.
function MockModelRegistryCtorImpl(this: unknown, runtime: MockModelRuntime): MockModelRegistry {
  return makeMockRegistry(runtime);
}
export const mockModelRegistryConstruct = mock(
  MockModelRegistryCtorImpl as unknown as (...args: unknown[]) => unknown
);

export const mockModelRuntimeCreate = mock(
  async (..._args: Parameters<typeof ModelRuntime.create>): Promise<MockModelRuntime> => ({
    checkAuth: mockCheckAuth,
    getModels: () => [createMockModel('google', 'gemini-2.5-pro')],
    setRuntimeApiKey: mockSetRuntimeApiKey,
    getAuth: mockGetAuth,
    hasConfiguredAuth: mockHasConfiguredAuth,
    getProviderAuthStatus: () => ({ configured: false }),
    listCredentials: async () => [],
  })
);

export const mockSessionCreate = mock((_cwd: string) => ({ __smKind: 'created' }));
export const mockSessionOpen = mock((_path: string) => ({ __smKind: 'opened' }));
export const mockSessionForkFrom = mock((_path: string, _cwd: string): { __smKind: string } => ({
  __smKind: 'forked',
}));
export const mockSessionList = mock(
  async (_cwd: string) => [] as { id: string; path: string; cwd: string }[]
);

export const mockSettingsManagerDrainErrors = mock((): { scope: string; error: Error }[] => []);
export const mockSettingsManagerGetGlobalSettings = mock(() => ({}));
export const mockSettingsManagerGetProjectSettings = mock(() => ({}));
export const mockSettingsManagerCreate = mock(() => ({
  drainErrors: mockSettingsManagerDrainErrors,
  getGlobalSettings: mockSettingsManagerGetGlobalSettings,
  getProjectSettings: mockSettingsManagerGetProjectSettings,
}));
export const mockSettingsManagerInMemory = mock((_settings?: unknown) => ({
  getDefaultTools: (): string[] | undefined => undefined,
}));
export const mockResourceLoaderReload = mock(async () => undefined);

// The SDK drains and replaces this queue when the first session binds extensions.
export const mockLoaderRuntime: { pendingProviderRegistrations: ExtensionProviderRegistration[] } =
  {
    pendingProviderRegistrations: [],
  };
export const mockGetExtensions = mock(() => ({
  extensions: [],
  errors: [],
  runtime: mockLoaderRuntime,
}));

export const MockDefaultResourceLoader = mock((_opts: unknown) => ({
  reload: mockResourceLoaderReload,
  getExtensions: mockGetExtensions,
}));
const mockGetAgentDir = mock(() => process.env.PI_CODING_AGENT_DIR?.trim() || '/mock/.pi/agent');

const mockCreateReadTool = mock((_cwd: string) => ({ __piTool: 'read' }));
export const mockCreateBashTool = mock((_cwd: string, _options?: unknown) => ({
  __piTool: 'bash',
}));
const mockCreateEditTool = mock((_cwd: string) => ({ __piTool: 'edit' }));
const mockCreateWriteTool = mock((_cwd: string) => ({ __piTool: 'write' }));
const mockCreateGrepTool = mock((_cwd: string) => ({ __piTool: 'grep' }));
const mockCreateFindTool = mock((_cwd: string) => ({ __piTool: 'find' }));
const mockCreateLsTool = mock((_cwd: string) => ({ __piTool: 'ls' }));
export const mockCreatePowerShellTool = mock((_cwd: string, _options?: unknown) => ({
  __piTool: 'powershell',
}));

export const mockDefineTool = mock(
  (def: {
    name: string;
    execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
  }) => def
);

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,

  ModelRuntime: {
    create: mockModelRuntimeCreate,
  },

  readStoredCredential: (providerId: string) => fileCreds[providerId],
  ModelRegistry: mockModelRegistryConstruct,
  SessionManager: {
    create: mockSessionCreate,
    open: mockSessionOpen,
    forkFrom: mockSessionForkFrom,
    list: mockSessionList,
  },
  SettingsManager: {
    create: mockSettingsManagerCreate,
    inMemory: mockSettingsManagerInMemory,
  },
  DefaultResourceLoader: MockDefaultResourceLoader,

  getAgentDir: mockGetAgentDir,
  createReadTool: mockCreateReadTool,
  createBashTool: mockCreateBashTool,
  createEditTool: mockCreateEditTool,
  createWriteTool: mockCreateWriteTool,
  createGrepTool: mockCreateGrepTool,
  createFindTool: mockCreateFindTool,
  createLsTool: mockCreateLsTool,
  createPowerShellTool: mockCreatePowerShellTool,
  defineTool: mockDefineTool,
}));

export async function consume(generator: AsyncGenerator<unknown>): Promise<{
  chunks: unknown[];
  error?: Error;
  /** The typed failure the turn's result reported, if it failed. */
  failure?: { class: string; evidence: string };
}> {
  const chunks: unknown[] = [];
  let failure: { class: string; evidence: string } | undefined;
  try {
    for await (const chunk of generator) {
      chunks.push(chunk);
      const result = chunk as { type?: string; failure?: { class: string; evidence: string } };
      if (result.type === 'result' && result.failure) failure = result.failure;
    }
    return { chunks, failure };
  } catch (err) {
    return { chunks, failure, error: err as Error };
  }
}

export function resetScript(events: FakeEvent[]): void {
  scriptedEvents.length = 0;
  scriptedEvents.push(...events);
}

export function readEnv(name: string): string | undefined {
  return process.env[name];
}

export function scriptedAgentEnd(): FakeEvent[] {
  return [
    {
      type: 'agent_end',
      willRetry: false,
      messages: [
        {
          role: 'assistant',
          api: 'test',
          provider: 'test',
          model: 'test',
          timestamp: 0,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          content: [],
        },
      ],
    },
  ];
}

beforeEach(() => {
  mock.clearAllMocks();
  mockLoaderRuntime.pendingProviderRegistrations = [];
  mockSessionList.mockImplementation(async () => []);
  mockSettingsManagerDrainErrors.mockReset();
  mockSettingsManagerDrainErrors.mockImplementation(() => []);
  mockSettingsManagerGetGlobalSettings.mockReset();
  mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({}));
  mockSettingsManagerGetProjectSettings.mockReset();
  mockSettingsManagerGetProjectSettings.mockImplementation(() => ({}));
  capturedListener = undefined;
  scriptedEvents.length = 0;
  fileCreds = {};
  runtimeOverrides = {};
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.ARCHON_PI_AUTH_PATH;

  resetReloadedExtensionLoaderCache();
});
