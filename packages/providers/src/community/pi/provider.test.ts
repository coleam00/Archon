import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';

// Typed against the real registration shape (config: ProviderConfig) so the
// mock runtime drifts loudly, not silently, if the SDK/type changes — same
// precedent as `AgentSessionEvent` above.
import type { ExtensionProviderRegistration } from './resource-loader';

import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths logger so provider instantiation is quiet ───────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock Pi SDK surface ────────────────────────────────────────────────
//
// Pi's `createAgentSession` returns a session whose `subscribe(listener)`
// stores a callback, and whose `prompt(text)` drives events through that
// callback before resolving. We reproduce that shape with a mutable
// `listener` variable plus `mockPrompt` that replays a scripted event
// sequence synchronously.

// Typed against Pi's actual event union so tests fail at compile time when
// Pi renames a field (e.g. `assistantMessageEvent` → `amEvent`) rather than
// silently passing while production drifts. Using `as AgentSessionEvent` at
// the call site covers the cases where we construct partial message objects.
type FakeEvent = AgentSessionEvent;
let capturedListener: ((event: FakeEvent) => void) | undefined;

const scriptedEvents: FakeEvent[] = [];
const mockPrompt = mock(async (_prompt: string): Promise<void> => {
  for (const ev of scriptedEvents) capturedListener?.(ev);
});
const mockAbort = mock(async () => undefined);
const mockDispose = mock(() => undefined);
const mockSubscribe = mock((listener: (event: FakeEvent) => void) => {
  capturedListener = listener;
  return () => {
    capturedListener = undefined;
  };
});

const mockBindExtensions = mock(async (_bindings: unknown) => undefined);
const mockSetFlagValue = mock((_name: string, _value: boolean | string) => undefined);
const mockExtensionRunner = {
  setFlagValue: mockSetFlagValue,
};
const mockSetModel = mock(async (_model: unknown) => undefined);
const mockSession = {
  subscribe: mockSubscribe,
  prompt: mockPrompt,
  abort: mockAbort,
  dispose: mockDispose,
  bindExtensions: mockBindExtensions,
  extensionRunner: mockExtensionRunner,
  setModel: mockSetModel,
  isStreaming: false,
  sessionId: 'mock-session-uuid',
};

function createMockSessionResult(modelFallbackMessage?: string): CreateAgentSessionResult {
  return {
    session: mockSession,
    extensionsResult: { extensions: [], errors: [], runtime: {} },
    modelFallbackMessage,
  } as unknown as CreateAgentSessionResult;
}

const mockCreateAgentSession = mock<
  typeof import('@earendil-works/pi-coding-agent').createAgentSession
>(
  async (_options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> =>
    createMockSessionResult()
);

// Per-test state backing the ModelRuntime mock. `fileCreds` emulates what's
// in ~/.pi/agent/auth.json; `runtimeOverrides` emulates env-var passthrough
// via setRuntimeApiKey. Tests mutate these via helpers.
let fileCreds: Record<
  string,
  { type: 'api_key' | 'oauth'; key?: string; env?: Record<string, string> }
> = {};
let runtimeOverrides: Record<string, string> = {};

const mockSetRuntimeApiKey = mock(async (providerId: string, key: string) => {
  runtimeOverrides[providerId] = key;
});
const mockGetAuth = mock(async (providerId: string) => {
  // Mirror Pi's runtime resolution: runtime override → file api_key → file
  // oauth → ambient (not exercised in unit tests). Returns the new
  // `AuthResult` shape so the provider can read `auth.apiKey` (the shape
  // discriminator for Anthropic subscription OAuth lives on the apiKey
  // value itself, so a raw string is fine).
  if (runtimeOverrides[providerId]) {
    return { auth: { apiKey: runtimeOverrides[providerId] }, source: 'runtime-override' };
  }
  const cred = fileCreds[providerId];
  if (cred?.type === 'api_key') return { auth: { apiKey: cred.key }, source: 'auth.json' };
  // Real Anthropic subscription OAuth access tokens are `sk-ant-oat…` — keep
  // the stub shape-accurate so token-shape-based detection is exercised.
  if (cred?.type === 'oauth')
    return { auth: { apiKey: 'sk-ant-oat01-file-stub' }, source: 'auth.json' };
  return undefined;
});
const mockHasConfiguredAuth = mock(
  (providerId: string) =>
    runtimeOverrides[providerId] !== undefined || fileCreds[providerId] !== undefined
);

function createMockModel(provider: string, modelId: string): Model<Api> {
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

const mockModelRegistryFind = mock<ModelRegistry['find']>((provider, modelId) => {
  if (provider === 'nonexistent') return undefined;
  return createMockModel(provider, modelId);
});
type MockModelRegistry = Pick<ModelRegistry, 'find'> &
  Partial<
    Pick<
      ModelRegistry,
      'getApiKeyAndHeaders' | 'getError' | 'hasConfiguredAuth' | 'registerProvider'
    >
  > & {
    /** Per-registry extension provider registrations, for assertions. */
    registered?: Map<string, unknown>;
  };
// pi 0.84.0+: ModelRegistry is a constructor that takes a ModelRuntime (the
// pre-0.84 static `ModelRegistry.create(authStorage)` factory is gone). The
// mock honours the new `new ModelRegistry(runtime)` shape; tests that
// previously poked at the auth passed to `ModelRegistry.create` now poke at
// the runtime passed to the constructor.
type MockModelRuntime = {
  setRuntimeApiKey(providerId: string, key: string): Promise<void>;
  getAuth(providerId: string): Promise<unknown>;
  hasConfiguredAuth(providerId: string): boolean;
};
type MockModelRegistryCtor = new (runtime: MockModelRuntime) => MockModelRegistry;
function makeMockRegistry(runtime: MockModelRuntime): MockModelRegistry {
  return {
    find: mockModelRegistryFind,
    hasConfiguredAuth: mock(model => runtime.hasConfiguredAuth(model.provider)),
    getApiKeyAndHeaders: mock(async model => {
      const resolution = (await runtime.getAuth(model.provider)) as
        | { auth: { apiKey?: string } }
        | undefined;
      return {
        ok: true as const,
        apiKey: resolution?.auth.apiKey,
        env: fileCreds[model.provider]?.env,
      };
    }),
    // Per-call extension provider registrations. The real ModelRegistry facade
    // forwards registerProvider() to its runtime; we mirror that by stashing
    // the (name, config) pair in a per-call map so tests can assert which
    // extensions the provider's extension re-apply step wrote through.
    registerProvider: ((name: string, config: unknown) => {
      mockRegistryRegistered.set(name, config);
    }) as ModelRegistry['registerProvider'],
    registered: mockRegistryRegistered,
  };
}

/** Per-registry provider registration map for the most-recent registry. */
const mockRegistryRegistered = new Map<string, unknown>();
// Constructor (mocked via `mock()`): the new SDK does `new ModelRegistry(runtime)`,
// so the replacement must behave as a class. bun's mock() of a function works
// through `mockImplementation`/etc.; for `new` we return-style (ES semantics
// use the explicit object return when a constructor returns one).
function MockModelRegistryCtorImpl(this: unknown, runtime: MockModelRuntime): MockModelRegistry {
  return makeMockRegistry(runtime);
}
const MockModelRegistry = MockModelRegistryCtorImpl as unknown as MockModelRegistryCtor;
const mockModelRegistryConstruct = mock(
  MockModelRegistryCtorImpl as unknown as (...args: unknown[]) => unknown
);

// ModelRuntime.create mock. Returns a fresh runtime whose methods delegate to
// the `mockSetRuntimeApiKey`/`mockGetAuth`/`mockHasConfiguredAuth` state above,
// so tests that previously poked `authStorage.setRuntimeApiKey(...)` or
// `authStorage.getApiKey(...)` continue to assert against the same call shape
// (just on the runtime object now).
const mockModelRuntimeCreate = mock(
  async (_options?: { authPath?: string; modelsPath?: string }): Promise<MockModelRuntime> => ({
    setRuntimeApiKey: mockSetRuntimeApiKey,
    getAuth: mockGetAuth,
    hasConfiguredAuth: mockHasConfiguredAuth,
  })
);

// SessionManager mocks. Each returns a tagged session-manager stub so tests
// can assert whether resume resolved to an existing session or fell through
// to a fresh one.
const mockSessionCreate = mock((_cwd: string) => ({ __smKind: 'created' }));
const mockSessionOpen = mock((_path: string) => ({ __smKind: 'opened' }));
const mockSessionForkFrom = mock((_path: string, _cwd: string): { __smKind: string } => ({
  __smKind: 'forked',
}));
const mockSessionList = mock(
  async (_cwd: string) => [] as { id: string; path: string; cwd: string }[]
);

const mockSettingsManagerDrainErrors = mock((): { scope: string; error: Error }[] => []);
const mockSettingsManagerGetGlobalSettings = mock(() => ({}));
const mockSettingsManagerGetProjectSettings = mock(() => ({}));
const mockSettingsManagerCreate = mock(() => ({
  drainErrors: mockSettingsManagerDrainErrors,
  getGlobalSettings: mockSettingsManagerGetGlobalSettings,
  getProjectSettings: mockSettingsManagerGetProjectSettings,
}));
const mockSettingsManagerInMemory = mock((_settings?: unknown) => ({}));
const mockResourceLoaderReload = mock(async () => undefined);
// Shared extension runtime exposed by the mock loader's getExtensions() —
// one object shared across sessions, exactly like Pi's real runtime. Tests
// seed `pendingProviderRegistrations` to simulate an extension factory
// calling pi.registerProvider() during the single cached reload()
// (issue #2064); the real SDK's bindCore() drains this queue into the FIRST
// session's registry and reassigns it to [].
const mockLoaderRuntime: { pendingProviderRegistrations: ExtensionProviderRegistration[] } = {
  pendingProviderRegistrations: [],
};
const mockGetExtensions = mock(() => ({
  extensions: [],
  errors: [],
  runtime: mockLoaderRuntime,
}));
// Return-style constructor: bun's mock() wraps the function such that the
// `this`-binding doesn't reliably propagate to `new` call sites. Returning a
// plain object from the constructor sidesteps this — ES semantics use the
// returned object when a constructor explicitly returns one.
const MockDefaultResourceLoader = mock((_opts: unknown) => ({
  reload: mockResourceLoaderReload,
  getExtensions: mockGetExtensions,
}));

// Tool factory mocks — each returns an opaque object tagged with the tool
// name so assertions can verify which tools the provider selected.
const mockCreateReadTool = mock((_cwd: string) => ({ __piTool: 'read' }));
const mockCreateBashTool = mock((_cwd: string, _options?: unknown) => ({ __piTool: 'bash' }));
const mockCreateEditTool = mock((_cwd: string) => ({ __piTool: 'edit' }));
const mockCreateWriteTool = mock((_cwd: string) => ({ __piTool: 'write' }));
const mockCreateGrepTool = mock((_cwd: string) => ({ __piTool: 'grep' }));
const mockCreateFindTool = mock((_cwd: string) => ({ __piTool: 'find' }));
const mockCreateLsTool = mock((_cwd: string) => ({ __piTool: 'ls' }));

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: mockCreateAgentSession,
  // pi 0.84.0+: ModelRuntime.create replaces AuthStorage.create; ModelRegistry
  // is now a `new`-able class constructed from a runtime (the pre-0.84 static
  // `ModelRegistry.create(authStorage)` factory is gone).
  ModelRuntime: {
    create: mockModelRuntimeCreate,
  },
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
  // Stub for the value import added when resource-loader.ts started passing
  // an explicit `agentDir` to DefaultResourceLoader (required since
  // pi-coding-agent 0.68+). Returns a deterministic path for tests.
  getAgentDir: () => '/mock/.pi/agent',
  createReadTool: mockCreateReadTool,
  createBashTool: mockCreateBashTool,
  createEditTool: mockCreateEditTool,
  createWriteTool: mockCreateWriteTool,
  createGrepTool: mockCreateGrepTool,
  createFindTool: mockCreateFindTool,
  createLsTool: mockCreateLsTool,
  // Value import required by ./native-tools (added when manage_run native tools
  // were wired into Pi). These tests don't pass nativeTools, so it's never
  // called — but the static `import { defineTool }` needs the binding to exist.
  defineTool: mock((def: unknown) => def),
}));

// Import AFTER mocks are set — module resolution freezes the mocks.
import { ARCHON_PI_ANTHROPIC_OAUTH_SYSTEM_PROMPT, PiProvider } from './provider';
import { PI_CAPABILITIES } from './capabilities';
// Same module instance the provider dynamic-imports, so clearing this cache
// resets the loader the provider reuses across calls (issue #1877).
import {
  getOrCreateReloadedExtensionLoader,
  resetReloadedExtensionLoaderCache,
} from './resource-loader';

// ─── Helpers ────────────────────────────────────────────────────────────

async function consume(
  generator: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of generator) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

function resetScript(events: FakeEvent[]): void {
  scriptedEvents.length = 0;
  scriptedEvents.push(...events);
}

function readEnv(name: string): string | undefined {
  return process.env[name];
}

// ─── Test suite ─────────────────────────────────────────────────────────

describe('PiProvider', () => {
  beforeEach(() => {
    mockLogger.fatal.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.trace.mockClear();
    mockPrompt.mockClear();
    mockAbort.mockClear();
    mockDispose.mockClear();
    mockSubscribe.mockClear();
    mockBindExtensions.mockClear();
    mockSetModel.mockClear();
    mockSetFlagValue.mockClear();
    mockResourceLoaderReload.mockClear();
    mockGetExtensions.mockClear();
    mockLoaderRuntime.pendingProviderRegistrations = [];
    mockCreateAgentSession.mockClear();
    mockModelRuntimeCreate.mockClear();
    mockModelRegistryConstruct.mockClear();
    mockModelRegistryFind.mockClear();
    mockSetRuntimeApiKey.mockClear();
    mockGetAuth.mockClear();
    mockHasConfiguredAuth.mockClear();
    MockDefaultResourceLoader.mockClear();
    mockCreateReadTool.mockClear();
    mockCreateBashTool.mockClear();
    mockCreateEditTool.mockClear();
    mockCreateWriteTool.mockClear();
    mockCreateGrepTool.mockClear();
    mockCreateFindTool.mockClear();
    mockCreateLsTool.mockClear();
    mockSessionCreate.mockClear();
    mockSessionOpen.mockClear();
    mockSessionForkFrom.mockClear();
    mockSessionList.mockClear();
    mockSessionList.mockImplementation(async () => []);
    mockSettingsManagerInMemory.mockClear();
    mockSettingsManagerCreate.mockClear();
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
    // The extension-loader cache is module-level and persists across tests;
    // clear it so each test starts with an empty cache and sees its own
    // construct/reload calls (issue #1877).
    resetReloadedExtensionLoaderCache();
  });

  test('getType returns "pi"', () => {
    expect(new PiProvider().getType()).toBe('pi');
  });

  test('getCapabilities matches PI_CAPABILITIES constant', () => {
    expect(new PiProvider().getCapabilities()).toEqual(PI_CAPABILITIES);
  });

  test('sendQuery installs PI_PACKAGE_DIR shim before Pi SDK loads', async () => {
    // Runtime-safety regression: Pi's config.js reads `getPackageJsonPath()` at
    // its module init, which resolves to a non-existent path inside compiled
    // archon binaries. The shim writes a stub package.json to tmpdir and sets
    // PI_PACKAGE_DIR so Pi's short-circuit kicks in. Must run BEFORE the
    // dynamic imports in sendQuery — we verify by calling the fast-fail "no
    // model" path (which returns before any Pi SDK logic executes) and
    // asserting the env var was set regardless.
    delete process.env.PI_PACKAGE_DIR;
    expect(process.env.PI_PACKAGE_DIR).toBeUndefined();
    await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(readEnv('PI_PACKAGE_DIR')).toBeDefined();
    expect(readEnv('PI_PACKAGE_DIR')).toContain('archon-pi-shim');

    // Stub contents are load-bearing: Pi reads `version` to populate its
    // user-agent and `piConfig` (even when empty) to opt into the defaults
    // path instead of erroring on missing config. Asserting on shape so a
    // regression here surfaces in the test suite, not in a Pi runtime crash.
    const shimDir = readEnv('PI_PACKAGE_DIR');
    expect(shimDir).toBe(join(tmpdir(), 'archon-pi-shim'));
    const stub = JSON.parse(readFileSync(join(shimDir!, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      piConfig: Record<string, unknown>;
    };
    expect(stub.name).toBe('archon-pi-shim');
    expect(stub.version).toBe('0.0.0');
    expect(stub.piConfig).toEqual({});
  });

  test('throws when no model is configured', async () => {
    const { error } = await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(error?.message).toContain('Pi provider requires a model');
  });

  test('throws when model ref is malformed', async () => {
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'sonnet' })
    );
    expect(error?.message).toContain('Invalid Pi model ref');
  });

  test('logs credential hint when Pi provider id is unknown AND no creds available', async () => {
    // No env var, no auth.json entry → log hint, but continue, to support custom providers that don't use credentials or that use non-Pi means of providing credentials.
    resetScript(scriptedAgentEnd());
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'unknownprovider/some-model',
      })
    );

    expect(error).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      {
        piProvider: 'unknownprovider',
        envHint: expect.stringContaining("not in the Archon adapter's env-var table"),
        loginHint: expect.stringContaining('/login'),
      },
      'pi.auth_missing'
    );
    expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
  });

  test('new ModelRegistry receives the ModelRuntime instance', async () => {
    // pi 0.84.0+: ModelRegistry is now a class constructed from a ModelRuntime
    // (the pre-0.84 `ModelRegistry.create(authStorage)` factory is gone). The
    // runtime the registry wraps is the same one we built with `setRuntimeApiKey`
    // calls and the same one createAgentSession uses to resolve auth on send.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(mockModelRuntimeCreate).toHaveBeenCalledTimes(1);
    expect(mockModelRegistryConstruct).toHaveBeenCalledTimes(1);
    // The runtime passed to the registry constructor is the resolved value
    // of the Promise returned by ModelRuntime.create (the wrapper awaits it
    // before constructing the registry, per the new SDK contract).
    const runtimeInstance = await mockModelRuntimeCreate.mock.results[0]?.value;
    expect(mockModelRegistryConstruct).toHaveBeenCalledWith(runtimeInstance);
  });

  test('custom provider: per-call models.json carries substituted ${VAR} values', async () => {
    // pi 0.84.0+ — the wrapper around the registry was dropped (it plugged
    // into a surface the SDK no longer consults during session auth; see
    // `request-auth.ts` for the full rationale). The replacement writes a
    // per-call `models.json` with `${VAR}` references substituted against
    // `requestOptions.env` and passes it as `modelsPath` to
    // `ModelRuntime.create`. The SDK then reads the literal at session-auth
    // time — no `process.env` fallback can fire, so the
    // `credentialless-custom-provider + per-call-secret` contract holds.
    // Regression for the review R1 finding (PR #2757).
    const userModelsDir = mkdtempSync(join(tmpdir(), 'archon-pi-test-user-models-'));
    const userModelsPath = join(userModelsDir, 'models.json');
    writeFileSync(
      userModelsPath,
      JSON.stringify({
        providers: {
          mygw: {
            baseUrl: 'https://gateway.example/v1',
            api: 'openai-completions',
            apiKey: 'prefix-${MYGW_API_KEY}',
            headers: { 'X-Project': '${MYGW_PROJECT}' },
            models: [{ id: 'demo' }],
          },
        },
      })
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = userModelsDir;

    // The per-call file is unlinked in `provider.ts`'s `finally` block as
    // soon as ModelRuntime.create resolves. The mock factory returns
    // synchronously without actually reading the file, so the cleanup
    // would race with the file-content assertions below. Capture the file
    // contents INSIDE the mock implementation, while the file still exists,
    // and assert against the captured snapshot.
    let capturedPerCallContent: string | undefined;
    mockModelRuntimeCreate.mockImplementationOnce(async (options?: { modelsPath?: string }) => {
      if (options?.modelsPath && existsSync(options.modelsPath)) {
        capturedPerCallContent = readFileSync(options.modelsPath, 'utf-8');
      }
      return {
        setRuntimeApiKey: mockSetRuntimeApiKey,
        getAuth: mockGetAuth,
        hasConfiguredAuth: mockHasConfiguredAuth,
      };
    });

    resetScript(scriptedAgentEnd());
    let createArgs: { authPath?: string; modelsPath?: string } | undefined;
    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: {
            MYGW_API_KEY: 'request-secret',
            MYGW_PROJECT: 'project-123',
            // ANTHROPIC_API_KEY is protected; a `${ANTHROPIC_API_KEY}` reference
            // in the user models.json must NEVER be substituted into the
            // per-call file. The current provider entry doesn't reference it,
            // so the protected-keys contract is a no-op for this test —
            // covered separately in request-auth.test.ts.
            ANTHROPIC_API_KEY: 'acting-user-secret',
          },
          protectedEnvKeys: ['ANTHROPIC_API_KEY'],
        })
      );

      // The runtime was created with a per-call modelsPath (the substituted
      // file), NOT the user's models.json — the SDK then reads the literal
      // substituted values directly without falling through to process.env.
      expect(mockModelRuntimeCreate).toHaveBeenCalledTimes(1);
      createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0] as
        | { authPath?: string; modelsPath?: string }
        | undefined;
      expect(createArgs?.modelsPath).toBeDefined();
      expect(createArgs?.modelsPath).not.toBe(userModelsPath);
      // The per-call file carried the substituted literals at create time.
      // The cleanup `finally` in provider.ts unlinks it as soon as create()
      // resolves — see the dedicated "per-call models.json is unlinked after
      // ModelRuntime.create" test below for the post-cleanup assertion.
      expect(capturedPerCallContent).toBeDefined();
      const perCallModels = JSON.parse(capturedPerCallContent as string) as {
        providers: Record<
          string,
          {
            apiKey: string;
            headers: Record<string, string>;
            models: { id: string }[];
            baseUrl: string;
          }
        >;
      };
      expect(perCallModels.providers.mygw.apiKey).toBe('prefix-request-secret');
      expect(perCallModels.providers.mygw.headers).toEqual({ 'X-Project': 'project-123' });
      expect(perCallModels.providers.mygw.models).toEqual([{ id: 'demo' }]);
      expect(perCallModels.providers.mygw.baseUrl).toBe('https://gateway.example/v1');

      // The wrapped registry is gone — no `getApiKeyAndHeaders` override on
      // the per-call registry.
      const requestRegistry = mockModelRegistryConstruct.mock.results[0]?.value as
        | MockModelRegistry
        | undefined;
      // The mock registry IS the runtime's view — assert it has the standard
      // methods (and not a wrapping that introduces overrides).
      expect(requestRegistry?.getApiKeyAndHeaders).toBeDefined();
      // The test never resolves a credential for `mygw`, so the SDK-side
      // auth path isn't reached. The mock registry's getApiKeyAndHeaders is
      // the bare mock — it should NOT have been called by anything in the
      // provider's pre-session path (the substitution happens at models.json
      // load time, before the session even constructs).
      expect(requestRegistry?.getApiKeyAndHeaders).not.toHaveBeenCalled();
    } finally {
      // Best-effort: if the per-call file is still on disk (cleanup didn't
      // run for some reason in this test path), unlink it so the dir
      // cleanup below doesn't blow up.
      if (createArgs?.modelsPath && existsSync(createArgs.modelsPath)) {
        rmSync(createArgs.modelsPath, { force: true });
      }
      rmSync(userModelsDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test('custom provider: per-call models.json is unlinked after ModelRuntime.create', async () => {
    // Round-2 review (Finding 3): the per-call models.json was written and
    // returned to the caller, but never deleted. Long-running processes
    // accumulate one file per sendQuery until mkdirSync/writeFileSync fails
    // with ENOSPC, after which buildCustomProviderModelsPath's errors are
    // caught at the caller and the SDK silently falls back to the
    // unsubstituted user models.json — re-opening the round-1 R1 leak
    // surface. The fix wraps ModelRuntime.create in a try/finally that
    // unlinks the file regardless of create() outcome.
    const userModelsDir = mkdtempSync(join(tmpdir(), 'archon-pi-test-user-models-cleanup-'));
    writeFileSync(
      join(userModelsDir, 'models.json'),
      JSON.stringify({
        providers: {
          mygw: {
            baseUrl: 'https://gateway.example/v1',
            api: 'openai-completions',
            apiKey: 'prefix-${MYGW_API_KEY}',
            models: [{ id: 'demo' }],
          },
        },
      })
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = userModelsDir;

    resetScript(scriptedAgentEnd());
    let perCallPath: string | undefined;
    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: { MYGW_API_KEY: 'request-secret' },
          protectedEnvKeys: [],
        })
      );
      const createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0] as
        | { modelsPath?: string }
        | undefined;
      perCallPath = createArgs?.modelsPath;
      expect(perCallPath).toBeDefined();
      // The cleanup ran in the provider's `finally` block, so the file is
      // gone after sendQuery resolves.
      expect(existsSync(perCallPath as string)).toBe(false);
    } finally {
      if (perCallPath && existsSync(perCallPath)) {
        rmSync(perCallPath, { force: true });
      }
      rmSync(userModelsDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test('custom provider: per-call models.json is unlinked even when ModelRuntime.create throws', async () => {
    // Round-2 review (Finding 3): cleanup must run on the failure path
    // too, otherwise a transient SDK failure (corrupt auth.json, transient
    // ENOSPC, etc.) leaks the per-call file. The file holds the literal
    // substituted secret, so leaving it on disk after a failed create()
    // is a credential-leak regression.
    const userModelsDir = mkdtempSync(join(tmpdir(), 'archon-pi-test-user-models-cleanup-fail-'));
    writeFileSync(
      join(userModelsDir, 'models.json'),
      JSON.stringify({
        providers: {
          mygw: {
            baseUrl: 'https://gateway.example/v1',
            api: 'openai-completions',
            apiKey: 'prefix-${MYGW_API_KEY}',
            models: [{ id: 'demo' }],
          },
        },
      })
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = userModelsDir;

    mockModelRuntimeCreate.mockImplementationOnce(async (options?: { modelsPath?: string }) => {
      // Force the SDK to throw AFTER reading the per-call file's existence
      // so the cleanup `finally` runs on the failure path. The provider
      // wraps the error in a "Pi auth storage init failed" message; we
      // assert the cleanup still happened regardless.
      if (options?.modelsPath) {
        // Touch the file so we can verify it disappears.
        if (existsSync(options.modelsPath)) {
          // ok
        }
      }
      throw new Error('simulated SDK failure');
    });

    try {
      const { error } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: { MYGW_API_KEY: 'request-secret' },
          protectedEnvKeys: [],
        })
      );
      expect(error).toBeDefined();
      expect(error?.message).toContain('Pi auth storage init failed');
      expect(error?.message).toContain('simulated SDK failure');
      // Capture the path from the call that DID happen (before the throw).
      const createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0] as
        | { modelsPath?: string }
        | undefined;
      expect(createArgs?.modelsPath).toBeDefined();
      // The cleanup ran in the failure path too — file is gone.
      expect(existsSync(createArgs!.modelsPath as string)).toBe(false);
    } finally {
      rmSync(userModelsDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test('custom provider: no ${VAR} references leaves modelsPath unset', async () => {
    // When the user's `models.json` entry has no template references, no
    // per-call file is needed — the SDK's default `modelsPath` lookup handles
    // the literal apiKey directly.
    const userModelsDir = mkdtempSync(join(tmpdir(), 'archon-pi-test-user-models-literal-'));
    writeFileSync(
      join(userModelsDir, 'models.json'),
      JSON.stringify({
        providers: { mygw: { baseUrl: 'https://gateway.example/v1', apiKey: 'literal-key' } },
      })
    );
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = userModelsDir;

    resetScript(scriptedAgentEnd());
    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: { MYGW_API_KEY: 'unused-because-no-template' },
          protectedEnvKeys: [],
        })
      );

      expect(mockModelRuntimeCreate).toHaveBeenCalledTimes(1);
      const createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0] as
        | { modelsPath?: string }
        | undefined;
      // No substitution was applicable → no per-call modelsPath passed.
      expect(createArgs?.modelsPath).toBeUndefined();
    } finally {
      rmSync(userModelsDir, { recursive: true, force: true });
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test('ModelRuntime.create reads ARCHON_PI_AUTH_PATH from requestOptions.env (per-user channel)', async () => {
    // The executor delivers per-user credentials — including the per-run
    // auth.json PATH — on the per-call requestOptions.env channel, which it
    // deliberately keeps OUT of process.env (subprocess-isolation). Pi runs
    // in-process, so it must read the path from requestOptions.env or per-user
    // subscription delivery silently no-ops (the auth.json is written but never
    // loaded). Regression for the VPS smoke finding where a claude→anthropic
    // subscription failed with "no credentials for provider 'anthropic'".
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());
    const perRunAuthPath = '/run/abc123/pi-home/auth.json';

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: { ARCHON_PI_AUTH_PATH: perRunAuthPath },
      })
    );

    expect(mockModelRuntimeCreate).toHaveBeenCalledWith({ authPath: perRunAuthPath });
  });

  test('ModelRuntime.create falls back to process.env.ARCHON_PI_AUTH_PATH (shell override)', async () => {
    // A shell-level ARCHON_PI_AUTH_PATH still applies when no per-call value is
    // present, preserving the local-dev / manual override path.
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());
    process.env.ARCHON_PI_AUTH_PATH = '/shell/override/auth.json';

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );

    expect(mockModelRuntimeCreate).toHaveBeenCalledWith({ authPath: '/shell/override/auth.json' });
  });

  test('ModelRuntime.create() throwing surfaces a contextualized error', async () => {
    // ModelRuntime.create() reads the auth.json from disk and can throw on
    // malformed JSON or filesystem errors. Wrap with try/catch and surface a
    // Pi-framed error so operators see the cause rather than a raw SDK stack
    // trace.
    mockModelRuntimeCreate.mockImplementationOnce(async () => {
      throw new Error('Unexpected token } in JSON at position 42');
    });

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(error).toBeDefined();
    expect(error?.message).toContain('Pi auth storage init failed');
    expect(error?.message).toContain('Unexpected token');
    expect(error?.message).toContain('~/.pi/agent/auth.json');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ piProvider: 'google' }),
      'pi.auth_storage_init_failed'
    );
  });

  test('Pi model not found includes models.json load error when registry reports one', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    // find() is called twice — first on the static catalog, then again after bindExtensions()
    // resolves extension providers. Both must return undefined to trigger the error.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryConstruct.mockImplementationOnce((runtime: unknown) => {
      const r = runtime as MockModelRuntime;
      return {
        find: mockModelRegistryFind,
        hasConfiguredAuth: mock((model: Model<Api>) => r.hasConfiguredAuth(model.provider)),
        getApiKeyAndHeaders: mock(async () => ({ ok: true as const })),
        getError: () => 'Provider lm-studio: "baseUrl" is required when defining custom models.',
      };
    });

    resetScript(scriptedAgentEnd());
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'lm-studio/some-model',
      })
    );

    expect(error?.message).toContain('Pi model not found');
    expect(error?.message).toContain('provider extension');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        piProvider: 'lm-studio',
        modelId: 'some-model',
        loadError: expect.stringContaining('"baseUrl" is required'),
      }),
      'pi.model_registry_load_error'
    );
  });

  test('throws when env var missing AND auth.json has no entry', async () => {
    // GEMINI_API_KEY not set (beforeEach deletes it), fileCreds empty
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error?.message).toContain('no credentials for provider');
    expect(error?.message).toContain('GEMINI_API_KEY');
    expect(error?.message).toContain('/login');
  });

  test('uses OAuth credential from ~/.pi/agent/auth.json when no env var set', async () => {
    // Simulate user running `pi /login` → auth.json has OAuth entry
    fileCreds.anthropic = { type: 'oauth' };
    resetScript([
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
    ]);

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(error).toBeUndefined();
    // Runtime override NOT set — no env var present — so Pi's getAuth
    // resolves through the OAuth code path.
    expect(mockSetRuntimeApiKey).not.toHaveBeenCalled();
    expect(mockGetAuth).toHaveBeenCalledWith('anthropic');
  });

  test('throws when ModelRegistry.find returns undefined', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    // find() is called twice — first on the static catalog, then again after bindExtensions()
    // resolves extension providers. Both must return undefined to trigger the error.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    resetScript(scriptedAgentEnd());
    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/unknown-model-id',
      })
    );
    expect(error?.message).toContain('Pi model not found');
    expect(error?.message).toContain('provider extension');
  });

  test('deferred resolution: calls session.setModel when find() resolves after bindExtensions', async () => {
    // Phase 1: model not in static catalog (extension provider path).
    // Phase 2: extension registers the model during bindExtensions() and find() succeeds.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryFind.mockImplementationOnce(() =>
      createMockModel('extension-provider', 'custom-model')
    );
    resetScript(scriptedAgentEnd());

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'extension-provider/custom-model',
      })
    );

    expect(error).toBeUndefined();
    expect(mockModelRegistryFind).toHaveBeenCalledTimes(2);
    expect(mockSetModel).toHaveBeenCalledTimes(1);
    expect(mockSetModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-model', provider: 'extension-provider' })
    );
  });

  test('request env (codebase env vars) overrides process.env via setRuntimeApiKey', async () => {
    process.env.GEMINI_API_KEY = 'from-process-env';
    resetScript([
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
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { GEMINI_API_KEY: 'from-request-env' },
      })
    );

    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('google', 'from-request-env');
    // Runtime override is priority #1 in Pi's resolution chain, so getApiKey
    // returns 'from-request-env' (via our mock's runtimeOverrides map).
    expect(runtimeOverrides.google).toBe('from-request-env');
  });

  test('env var overrides auth.json api_key entry', async () => {
    // Both present: env var wins (mirrors Pi's resolution priority)
    fileCreds.anthropic = { type: 'api_key', key: 'from-auth-json' };
    process.env.ANTHROPIC_API_KEY = 'from-env';
    resetScript([
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
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'from-env');
  });

  test('ANTHROPIC_OAUTH_TOKEN (subscription) routes into setRuntimeApiKey for anthropic (#1984)', async () => {
    // Env-only chat delivers a Claude Pro/Max subscription under the OAuth var.
    // The bridge must read it (Pi never sees requestOptions.env via process.env),
    // and the sk-ant-oat* bearer flows through the same runtime channel — pi-ai's
    // createClient detects OAuth by token content downstream.
    resetScript([
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
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: { ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-bearer' },
      })
    );
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-oat01-bearer');
  });

  test('OAuth var wins over the API-key var when both are delivered (#1984)', async () => {
    resetScript([
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
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: {
          ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-bearer',
          ANTHROPIC_API_KEY: 'sk-ant-apikey',
        },
      })
    );
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-oat01-bearer');
  });

  test('ANTHROPIC_OAUTH_TOKEN is read from process.env when absent from request env (#1984)', async () => {
    // Shell/ambient override parity with the API-key var path.
    process.env.ANTHROPIC_OAUTH_TOKEN = 'sk-ant-oat01-proc';
    resetScript([
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
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-oat01-proc');
  });

  test('coalesces text_delta events into a single assistant chunk (#1814)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Hello',
          partial: {} as never,
        },
      },
      {
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: ' world',
          partial: {} as never,
        },
      },
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
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            content: [],
          },
        ],
      },
    ]);

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    // Consecutive text_delta events are coalesced into one block-level chunk
    // (flushed before the terminal result) so downstream consumers don't see
    // fragmented "Hello\n\n world" output — see #1814.
    expect(chunks).toEqual([
      { type: 'assistant', content: 'Hello world' },
      expect.objectContaining({ type: 'result', stopReason: 'stop' }),
    ]);
  });

  test('yields tool + tool_result chunks for tool_execution events', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: '/x' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'read',
        result: 'contents',
        isError: false,
      },
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
    ]);

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toMatchObject({
      type: 'tool',
      toolName: 'read',
      toolInput: { path: '/x' },
      toolCallId: 'call-1',
    });
    expect(chunks[1]).toMatchObject({
      type: 'tool_result',
      toolName: 'read',
      toolOutput: 'contents',
      toolCallId: 'call-1',
    });
    expect(chunks[2]).toMatchObject({ type: 'result' });
  });

  test('resumeSessionId not found → fresh session + system warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => []);
    resetScript([
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
    ]);

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'nonexistent-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    // Resume attempted: list() called; no match → create() called (fresh session)
    expect(mockSessionList).toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledWith('/tmp');
    expect(mockSessionOpen).not.toHaveBeenCalled();
    // Resume failure surfaces as a system warning
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('Could not resume'))).toBe(true);
    // ...and as resumed:false on the result chunk so the executor can surface it.
    expect(chunks.find(c => (c as { type?: string }).type === 'result')).toMatchObject({
      resumed: false,
    });
  });

  test('resumeSessionId matches existing session → open by path, no warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => [
      { id: 'existing-id', path: '/sessions/existing-id.jsonl', cwd: '/tmp' },
    ]);
    resetScript([
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
    ]);

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'existing-id', {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error).toBeUndefined();
    expect(mockSessionOpen).toHaveBeenCalledWith('/sessions/existing-id.jsonl');
    expect(mockSessionForkFrom).not.toHaveBeenCalled();
    expect(mockSessionCreate).not.toHaveBeenCalled();
    // No resume_failed warning
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('Could not resume'))).toBe(false);
    // A warm resume reports resumed:true on the result chunk.
    expect(chunks.find(c => (c as { type?: string }).type === 'result')).toMatchObject({
      resumed: true,
    });
  });

  test('forkSession resumes into a distinct branch without opening the source', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSessionList.mockImplementationOnce(async () => [
      { id: 'source-id', path: '/sessions/source-id.jsonl', cwd: '/tmp' },
    ]);
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', 'source-id', {
        model: 'google/gemini-2.5-pro',
        forkSession: true,
      })
    );

    expect(error).toBeUndefined();
    expect(mockSessionForkFrom).toHaveBeenCalledWith('/sessions/source-id.jsonl', '/tmp');
    expect(mockSessionOpen).not.toHaveBeenCalled();
    expect(chunks.find(c => (c as { type?: string }).type === 'result')).toMatchObject({
      resumed: true,
      sessionId: 'mock-session-uuid',
    });
  });

  test('result chunk carries Pi sessionId (for Archon to store and reuse)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const resultChunk = chunks.find(
      (c): c is { type: 'result'; sessionId?: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(resultChunk).toBeDefined();
    expect(resultChunk?.sessionId).toBe('mock-session-uuid');
  });

  test('disposes session after completion', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript([
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
    ]);

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  // ─── v2 wiring: thinking, tools, systemPrompt ─────────────────────────

  function scriptedAgentEnd(): FakeEvent[] {
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

  test('nodeConfig.thinking=high passes thinkingLevel to createAgentSession', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { thinking: 'high' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBe('high');
  });

  test('nodeConfig.effort=medium passes thinkingLevel when thinking absent', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { effort: 'medium' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBe('medium');
  });

  test('nodeConfig.thinking=off omits thinkingLevel (Pi runs without explicit thinking)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { thinking: 'off' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBeUndefined();
  });

  test('Claude-shape object thinking yields system warning and is not applied', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { thinking: { type: 'enabled', budget_tokens: 4000 } },
      })
    );

    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('object form is Claude-specific'))).toBe(true);

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs.thinkingLevel).toBeUndefined();
  });

  test('nodeConfig.allowed_tools filters Pi built-in tools', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'grep'] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Pi 0.68+: customTools holds the actual Tool objects; noTools: "builtin"
    // suppresses Pi's default built-in set so the customTools list is authoritative.
    expect(Array.isArray(callArgs.customTools)).toBe(true);
    expect(callArgs.noTools).toBe('builtin');
    const tools = callArgs.customTools as Array<{ __piTool: string }>;
    expect(tools.map(t => t.__piTool).sort()).toEqual(['grep', 'read']);
  });

  test('nodeConfig.allowed_tools: [] disables all Pi tools (LLM-only)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: [] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Empty customTools + noTools: "builtin" == "no tools at all".
    expect(callArgs.customTools).toEqual([]);
    expect(callArgs.noTools).toBe('builtin');
  });

  test('unknown tool names yield system warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'WebFetch'] },
      })
    );

    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('WebFetch'))).toBe(true);
  });

  test('denied_tools alone starts from full built-in set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { denied_tools: ['bash', 'write'] },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    const tools = callArgs.customTools as Array<{ __piTool: string }>;
    expect(callArgs.noTools).toBe('builtin');
    // Pi has 7 built-ins, 2 denied → 5 remain
    expect(tools).toHaveLength(5);
    expect(tools.find(t => t.__piTool === 'bash')).toBeUndefined();
    expect(tools.find(t => t.__piTool === 'write')).toBeUndefined();
  });

  test('no allowed_tools / denied_tools leaves Pi default tools in place', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // No overrides → neither customTools nor noTools should be set; Pi uses
    // its default built-in tools.
    expect('customTools' in callArgs).toBe(false);
    expect('noTools' in callArgs).toBe(false);
  });

  test('requestOptions.env with no tool restrictions overrides Pi defaults with env-aware bash', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: { DATABASE_URL: 'postgres://managed' },
      })
    );

    const [callArgs] = mockCreateAgentSession.mock.calls[0] as [Record<string, unknown>];
    // Env present → we override Pi's built-in defaults so bash sees the env.
    const tools = callArgs.customTools as Array<{ __piTool: string }>;
    expect(Array.isArray(tools)).toBe(true);
    expect(callArgs.noTools).toBe('builtin');
    expect(tools.map(t => t.__piTool).sort()).toEqual(['bash', 'edit', 'read', 'write']);

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    expect(bashCall).toBeDefined();
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    expect(typeof bashOptions.spawnHook).toBe('function');

    // The spawnHook must merge caller env OVER Pi's inherited baseline, matching
    // Claude's { ...subprocessEnv, ...requestOptions.env } and Codex's buildCodexEnv.
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: '/usr/bin', DATABASE_URL: 'postgres://stale' },
    }) as { env: Record<string, string> };
    expect(merged.env.PATH).toBe('/usr/bin');
    expect(merged.env.DATABASE_URL).toBe('postgres://managed');
  });

  test('requestOptions.env threads through to bash tool when allowed_tools includes bash', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { allowed_tools: ['read', 'bash'] },
        env: { STRIPE_KEY: 'sk_test_abc' },
      })
    );

    const bashCall = mockCreateBashTool.mock.calls.find(call => call[1] !== undefined);
    expect(bashCall).toBeDefined();
    const bashOptions = bashCall![1] as { spawnHook: (c: unknown) => unknown };
    const merged = bashOptions.spawnHook({
      command: 'echo',
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    }) as { env: Record<string, string> };
    expect(merged.env.STRIPE_KEY).toBe('sk_test_abc');
    expect(merged.env.PATH).toBe('/usr/bin');
  });

  test('empty requestOptions.env does NOT construct a spawnHook', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        env: {},
      })
    );

    // Every createBashTool call in this test path is either (cwd) or (cwd, undefined).
    for (const call of mockCreateBashTool.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  test('requestOptions.systemPrompt threads through to DefaultResourceLoader', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: 'You are a careful investigator.',
      })
    );

    // DefaultResourceLoader constructor received systemPrompt
    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('You are a careful investigator.');
    expect(loaderArgs?.noExtensions).toBe(false);
    expect(loaderArgs?.noContextFiles).toBe(true);
  });

  test('nodeConfig.systemPrompt used when requestOptions.systemPrompt absent', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { systemPrompt: 'node-level prompt' },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('node-level prompt');
  });

  test('requestOptions.systemPrompt wins over nodeConfig.systemPrompt', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: 'request-level wins',
        nodeConfig: { systemPrompt: 'node-level' },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('request-level wins');
  });

  test('preset object systemPrompt is dropped with warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'extra',
        } as unknown as string,
      })
    );

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptType: 'object' }),
      'pi.system_prompt_dropped_non_string'
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBeUndefined();
  });

  test('invalid request-level systemPrompt does not mask valid node-level prompt', async () => {
    // Regression: a non-string request-level prompt (preset object) must NOT win
    // via `??` and shadow a valid node-level string — each level is validated
    // independently before precedence applies.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'extra',
        } as unknown as string,
        nodeConfig: { systemPrompt: 'node-level prompt' },
      })
    );

    // The dropped request-level object is reported, tagged with its source.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptType: 'object', systemPromptSource: 'request' }),
      'pi.system_prompt_dropped_non_string'
    );

    // The valid node-level string is used.
    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('node-level prompt');
  });

  // ─── Anthropic subscription-OAuth default system prompt (#1831) ───────

  test('Anthropic OAuth session (env token) falls back to the OAuth-safe default prompt', async () => {
    // A subscription token (sk-ant-oat*) with no explicit systemPrompt must
    // suppress Pi's built-in prompt — Anthropic's OAuth endpoint 400s it.
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: { ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-bearer' },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe(ARCHON_PI_ANTHROPIC_OAUTH_SYSTEM_PROMPT);
  });

  test('Anthropic OAuth session (auth.json subscription cred) falls back to the default prompt', async () => {
    // Same detection via the `pi /login` path: getApiKey resolves the stored
    // OAuth access token (sk-ant-oat*), no env var involved.
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe(ARCHON_PI_ANTHROPIC_OAUTH_SYSTEM_PROMPT);
  });

  test('Anthropic API-key session keeps Pi built-in prompt (systemPrompt undefined)', async () => {
    // Narrowed scope: API-key auth is not affected by the OAuth classifier, so
    // Pi's built-in prompt (with its dynamic tool list) must stay intact.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-key';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBeUndefined();
  });

  test('non-Anthropic backend keeps Pi built-in prompt (systemPrompt undefined)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBeUndefined();
  });

  test('explicit systemPrompt wins over the OAuth default on an OAuth session', async () => {
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        env: { ANTHROPIC_OAUTH_TOKEN: 'sk-ant-oat01-bearer' },
        nodeConfig: { systemPrompt: 'node-level custom prompt' },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('node-level custom prompt');
  });

  test('ARCHON_PI_ANTHROPIC_OAUTH_SYSTEM_PROMPT carries no third-party "pi harness" tell', () => {
    // Regression guard: the default must never reintroduce the self-referential
    // vocabulary that trips Anthropic's subscription-OAuth detector.
    const p = ARCHON_PI_ANTHROPIC_OAUTH_SYSTEM_PROMPT.toLowerCase();
    expect(p).not.toContain('pi documentation');
    expect(p).not.toContain('coding agent harness');
    expect(p).not.toContain('operating inside pi');
  });

  test('capabilities reflect v2 wiring', () => {
    const caps = new PiProvider().getCapabilities();
    expect(caps.thinkingControl).toBe(true);
    expect(caps.effortControl).toBe(true);
    expect(caps.toolRestrictions).toBe(true);
    expect(caps.skills).toBe(true);
    expect(caps.sessionResume).toBe(true);
    expect(caps.envInjection).toBe(true);
    // Best-effort structured output via prompt engineering (not SDK-enforced).
    expect(caps.structuredOutput).toBe('best-effort');
    // Still false:
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
  });

  test('extensions are enabled by default (noExtensions: false)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    // Extensions (community packages and user-authored) are a core reason
    // users run Pi; off-by-default silently broke users who installed or
    // authored one and expected it to fire.
    expect(loaderArgs?.noExtensions).toBe(false);
    // Skills/prompts/themes/context stay suppressed — only extensions flip on.
    expect(loaderArgs?.noSkills).toBe(true);
    expect(loaderArgs?.noPromptTemplates).toBe(true);
    expect(loaderArgs?.noThemes).toBe(true);
    expect(loaderArgs?.noContextFiles).toBe(true);
  });

  test('assistantConfig.enableExtensions: true flips noExtensions to false', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.noExtensions).toBe(false);
    // Skills/prompts/themes/context still suppressed — only extensions opt-in.
    expect(loaderArgs?.noSkills).toBe(true);
    expect(loaderArgs?.noPromptTemplates).toBe(true);
    expect(loaderArgs?.noThemes).toBe(true);
    expect(loaderArgs?.noContextFiles).toBe(true);
  });

  test('assistantConfig.enableExtensions: false keeps noExtensions: true', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false },
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.noExtensions).toBe(true);
  });

  test('nodeConfig.skills with unknown name yields system warning, does not abort', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp/nonexistent-cwd', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { skills: ['definitely-does-not-exist'] },
      })
    );
    expect(error).toBeUndefined();
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('definitely-does-not-exist'))).toBe(true);

    // DefaultResourceLoader instantiated without additionalSkillPaths (all missing)
    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.additionalSkillPaths).toBeUndefined();
  });

  test('nodeConfig.skills absent → no additionalSkillPaths option passed', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect('additionalSkillPaths' in (loaderArgs ?? {})).toBe(false);
  });

  // ─── Error + lifecycle paths (review: "zero test coverage") ─────────

  test('session.prompt rejection surfaces as thrown error to consumer', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const promptError = new Error('pi backend exploded');
    mockPrompt.mockImplementationOnce(async () => {
      throw promptError;
    });

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    expect(error?.message).toBe('pi backend exploded');
    // dispose still happens on error path
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test('pre-aborted signal triggers session.abort before any yielding', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    const controller = new AbortController();
    controller.abort();

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: controller.signal,
      })
    );
    expect(mockAbort).toHaveBeenCalled();
  });

  test('abort signal mid-stream calls session.abort', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const controller = new AbortController();
    // Drive the listener with one chunk, then abort, then agent_end.
    mockPrompt.mockImplementationOnce(async () => {
      capturedListener?.({
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'partial',
          partial: { role: 'assistant' } as never,
        },
      });
      controller.abort();
      capturedListener?.({
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
          } as never,
        ],
      });
    });

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        abortSignal: controller.signal,
      })
    );
    expect(mockAbort).toHaveBeenCalled();
  });

  test('modelFallbackMessage yields a system chunk before the agent runs', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    mockCreateAgentSession.mockImplementationOnce(
      async (): Promise<CreateAgentSessionResult> =>
        createMockSessionResult('Requested sonnet-5 not available, using haiku.')
    );
    resetScript(scriptedAgentEnd());

    const { chunks } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );
    const systemChunks = chunks.filter(
      (c): c is { type: 'system'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'system'
    );
    expect(systemChunks.some(c => c.content.includes('sonnet-5 not available'))).toBe(true);
  });

  // ─── structured output (best-effort JSON via prompt engineering) ──────

  // Script an assistant text_delta followed by agent_end so the bridge has
  // buffered content to parse when outputFormat is set.
  function scriptedAssistantThenEnd(text: string): FakeEvent[] {
    return [
      {
        type: 'message_update',
        message: { role: 'assistant' } as never,
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: { role: 'assistant' } as never,
        },
      },
      ...scriptedAgentEnd(),
    ];
  }

  test('outputFormat: schema is appended to prompt as JSON instruction', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('Summarize this bug.', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { area: { type: 'string' } } },
        },
      })
    );

    // Prompt should now contain the original instruction + the schema hint.
    expect(mockPrompt).toHaveBeenCalled();
    const [sentPrompt] = mockPrompt.mock.calls[0] as [string];
    expect(sentPrompt).toContain('Summarize this bug.');
    expect(sentPrompt).toContain('Respond with ONLY a JSON object');
    expect(sentPrompt).toContain('"area"');
  });

  test('outputFormat: absent → prompt passed through unchanged', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('do a thing', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const [sentPrompt] = mockPrompt.mock.calls[0] as [string];
    expect(sentPrompt).toBe('do a thing');
    expect(sentPrompt).not.toContain('JSON');
  });

  test('outputFormat: result chunk carries parsed structuredOutput on clean JSON', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('{"area":"web","confidence":0.9}'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('classify', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object' },
        },
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result?.structuredOutput).toEqual({ area: 'web', confidence: 0.9 });
  });

  test('outputFormat: fenced JSON (```json ... ```) still parses', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('```json\n{"ok":true}\n```'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.structuredOutput).toEqual({ ok: true });
  });

  test('outputFormat: prose-wrapped JSON → no structuredOutput, degrades cleanly', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('Here is the JSON:\n{"ok":true}\nHope this helps!'));

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        outputFormat: { type: 'json_schema', schema: {} },
      })
    );

    // No crash — downstream degradation is the executor's job via its
    // existing dag.structured_output_missing warning path.
    expect(error).toBeUndefined();
    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result?.structuredOutput).toBeUndefined();
  });

  test('no outputFormat → structuredOutput never set even if assistant emits JSON', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAssistantThenEnd('{"accidental":"json"}'));

    const { chunks } = await consume(
      new PiProvider().sendQuery('x', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const result = chunks.find(
      (c): c is { type: 'result'; structuredOutput?: unknown } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.structuredOutput).toBeUndefined();
  });

  // ─── Interactive ExtensionUIContext binding ───────────────────────────

  test('interactive: true with enableExtensions binds a UIContext to the session', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true, interactive: true },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  test('enableExtensions: false disables binding even if interactive: true is set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false, interactive: true },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
  });

  test('interactive: false with extensions on binds empty (session_start fires, no UIContext)', async () => {
    // When extensions are loaded, session_start MUST fire so each extension's
    // startup handler runs (reads flags, registers tools, etc.). Binding with
    // no uiContext keeps Pi's internal noOpUIContext active so hasUI stays
    // false — extensions that gate UI flows (like plannotator) will auto-approve
    // in this mode.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { interactive: false },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
  });

  test('default (nothing set) binds with UIContext — extensions + interactive both on', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  // ─── extensionFlags pass-through ──────────────────────────────────────

  test('extensionFlags sets flag values before bindExtensions fires session_start', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    // Track call order: setFlagValue must run BEFORE bindExtensions, else
    // extensions reading flags in their session_start handler miss them.
    const callOrder: string[] = [];
    mockSetFlagValue.mockImplementationOnce(() => {
      callOrder.push('setFlagValue');
      return undefined;
    });
    mockSetFlagValue.mockImplementationOnce(() => {
      callOrder.push('setFlagValue');
      return undefined;
    });
    mockBindExtensions.mockImplementationOnce(async () => {
      callOrder.push('bindExtensions');
    });

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true, 'plan-file': 'PLAN.md' },
        },
      })
    );

    expect(mockSetFlagValue).toHaveBeenCalledTimes(2);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan-file', 'PLAN.md');
    expect(callOrder).toEqual(['setFlagValue', 'setFlagValue', 'bindExtensions']);
  });

  test('extensionFlags is a no-op when enableExtensions is explicitly false', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false, extensionFlags: { plan: true } },
      })
    );

    expect(mockSetFlagValue).not.toHaveBeenCalled();
    expect(mockBindExtensions).not.toHaveBeenCalled();
  });

  // ─── Per-node extension posture (assistants.pi.nodes.<nodeId>, #2073) ──

  test('node override drops UIContext and negates the plan flag for that node', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          nodes: { implement: { interactive: false, extensionFlags: { plan: false } } },
        },
        nodeConfig: { nodeId: 'implement' },
      })
    );

    // Extensions still load (session_start must fire) but with no UIContext —
    // hasUI stays false so plannotator won't open its blocking review server.
    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
    // Merged flags: node-level plan: false wins over assistant-level plan: true.
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', false);
  });

  test('node without an override keeps assistant-level UIContext and flags', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          nodes: { implement: { interactive: false, extensionFlags: { plan: false } } },
        },
        nodeConfig: { nodeId: 'plan' },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
  });

  test('direct chat (no nodeConfig) ignores nodes overrides', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          interactive: true,
          nodes: { implement: { interactive: false } },
        },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
  });

  test('node enableExtensions: false skips binding entirely for that node', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          nodes: { implement: { enableExtensions: false } },
        },
        nodeConfig: { nodeId: 'implement' },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
    expect(mockSetFlagValue).not.toHaveBeenCalled();
  });

  // ─── Portable node-YAML posture (nodeConfig.pi, #2133) ─────────────────

  test('node-YAML pi overrides the config nodes.<id> map (drops UI, negates plan)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          extensionFlags: { plan: true },
          // config map says implement is UI-on with plan: true …
          nodes: { implement: { interactive: true, extensionFlags: { plan: true } } },
        },
        // … but the portable node-YAML block wins and turns it headless.
        nodeConfig: {
          nodeId: 'implement',
          pi: { interactive: false, extensionFlags: { plan: false } },
        },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeUndefined();
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', false);
  });

  test('node-YAML pi grants posture with no config nodes map present', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: true, interactive: false },
        // No nodes map; the node's own pi: block re-enables the UI bridge and grants plan.
        nodeConfig: { nodeId: 'plan', pi: { interactive: true, extensionFlags: { plan: true } } },
      })
    );

    expect(mockBindExtensions).toHaveBeenCalledTimes(1);
    const [bindings] = mockBindExtensions.mock.calls[0] as [{ uiContext?: unknown }];
    expect(bindings.uiContext).toBeDefined();
    expect(mockSetFlagValue).toHaveBeenCalledTimes(1);
    expect(mockSetFlagValue).toHaveBeenCalledWith('plan', true);
  });

  test('node-YAML pi enableExtensions: false skips binding even when the config map re-enables', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: {
          enableExtensions: true,
          interactive: true,
          nodes: { implement: { enableExtensions: true, interactive: true } },
        },
        nodeConfig: { nodeId: 'implement', pi: { enableExtensions: false } },
      })
    );

    expect(mockBindExtensions).not.toHaveBeenCalled();
    expect(mockSetFlagValue).not.toHaveBeenCalled();
  });

  test('assistantConfig.env applies to process.env when not already set', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    delete process.env.PI_TEST_ONE;
    delete process.env.PI_TEST_TWO;
    resetScript(scriptedAgentEnd());

    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          assistantConfig: { env: { PI_TEST_ONE: 'one', PI_TEST_TWO: 'two' } },
        })
      );

      expect(readEnv('PI_TEST_ONE')).toBe('one');
      expect(readEnv('PI_TEST_TWO')).toBe('two');
    } finally {
      delete process.env.PI_TEST_ONE;
      delete process.env.PI_TEST_TWO;
    }
  });

  test('shell env wins over assistantConfig.env (no override)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    process.env.PI_TEST_SHELL_WINS = 'shell-value';
    resetScript(scriptedAgentEnd());

    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          assistantConfig: { env: { PI_TEST_SHELL_WINS: 'config-value' } },
        })
      );

      expect(process.env.PI_TEST_SHELL_WINS).toBe('shell-value');
    } finally {
      delete process.env.PI_TEST_SHELL_WINS;
    }
  });

  // Semaphore tests run last — the module-level piSemaphore singleton persists
  // across tests once initialized, so these must not affect tests that run before.
  test('maxConcurrent initializes semaphore and logs pi.semaphore_initialized', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { maxConcurrent: 2 },
      })
    );

    expect(mockLogger.info).toHaveBeenCalledWith({ maxConcurrent: 2 }, 'pi.semaphore_initialized');
    // Semaphore slot released: dispose fires on successful completion
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  test('semaphore is not initialized when maxConcurrent is absent', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
      })
    );

    const initCalls = (mockLogger.info.mock.calls as unknown[][]).filter(
      c => c[1] === 'pi.semaphore_initialized'
    );
    expect(initCalls).toHaveLength(0);
  });

  test('settings: create(cwd) called, inMemory seeded with pre-merged global+project (empty project → just global)', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({ defaultProvider: 'google' }));
    mockSettingsManagerGetProjectSettings.mockImplementation(() => ({}));

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
    );

    expect(mockSettingsManagerCreate).toHaveBeenCalledTimes(1);
    expect(mockSettingsManagerCreate).toHaveBeenCalledWith('/tmp');
    expect(mockSettingsManagerInMemory).toHaveBeenCalledWith({ defaultProvider: 'google' });
  });

  test('settings: inMemory seeded with project settings merged on top of global', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({}));
    mockSettingsManagerGetProjectSettings.mockImplementation(() => ({ retry: { enabled: true } }));

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
    );

    expect(mockSettingsManagerInMemory).toHaveBeenCalledWith({ retry: { enabled: true } });
  });

  test('settings: object values are shallow-merged one level deep, while primitives and arrays override', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({
      retry: {
        enabled: false,
        attempts: 1,
        nested: { source: 'global', keep: true },
      },
      timeoutMs: 1000,
      allow: ['global'],
    }));
    mockSettingsManagerGetProjectSettings.mockImplementation(() => ({
      retry: {
        enabled: true,
        backoff: 'exp',
        nested: { source: 'project' },
      },
      timeoutMs: 2000,
      allow: ['project'],
    }));

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
    );

    expect(mockSettingsManagerInMemory).toHaveBeenCalledWith({
      retry: {
        enabled: true,
        attempts: 1,
        backoff: 'exp',
        nested: { source: 'project' }, // nested objects are NOT recursively merged — one level deep only
      },
      timeoutMs: 2000,
      allow: ['project'],
    });
  });

  test('settings: parse errors logged as warnings, session still proceeds', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());
    const loadError = new Error('bad JSON');
    mockSettingsManagerDrainErrors.mockImplementation(() => [
      { scope: 'global', error: loadError },
    ]);

    const { error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
    );

    expect(error).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', err: loadError }),
      'pi.settings_load_error'
    );
  });

  // ─── Extension loader reuse (issue #1877) ─────────────────────────────────
  //
  // Pi's reload() re-invokes every installed extension factory; the 2nd reload
  // in a process deadlocks on the first call's never-torn-down state. The fix
  // loads the extension-bearing loader ONCE per process per input set and
  // reuses it — so reload()/construct must run once across identical calls,
  // while each call still gets its own session.
  describe('extension loader reuse (issue #1877)', () => {
    test('reload() and loader construction run once across two sequential calls with identical inputs', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      await consume(
        new PiProvider().sendQuery('a', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );
      await consume(
        new PiProvider().sendQuery('b', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );

      // The bug was reload() (and the extension factory it drives) running per
      // call; after the fix the cached loader is built + reloaded exactly once.
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(1);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
      // Each call still gets its own session (correctness preserved).
      expect(mockCreateAgentSession).toHaveBeenCalledTimes(2);
      expect(mockDispose).toHaveBeenCalledTimes(2);
    });

    test('different cwd gets its own reloaded loader', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      await consume(
        new PiProvider().sendQuery('a', '/tmp/one', undefined, { model: 'google/gemini-2.5-pro' })
      );
      await consume(
        new PiProvider().sendQuery('b', '/tmp/two', undefined, { model: 'google/gemini-2.5-pro' })
      );

      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('a distinct per-node systemPrompt gets its own reloaded loader (no silent prompt reuse)', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      await consume(
        new PiProvider().sendQuery('a', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          systemPrompt: 'prompt A',
        })
      );
      await consume(
        new PiProvider().sendQuery('b', '/tmp', undefined, {
          model: 'google/gemini-2.5-pro',
          systemPrompt: 'prompt B',
        })
      );

      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('extensions disabled keeps a fresh loader per call and never reloads', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      resetScript(scriptedAgentEnd());

      const opts = {
        model: 'google/gemini-2.5-pro',
        assistantConfig: { enableExtensions: false },
      };
      await consume(new PiProvider().sendQuery('a', '/tmp', undefined, opts));
      await consume(new PiProvider().sendQuery('b', '/tmp', undefined, opts));

      // No caching on the extensions-off path: fresh loader each call, no reload.
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).not.toHaveBeenCalled();
    });

    test('distinct additionalSkillPaths get their own reloaded loader', async () => {
      const a = await getOrCreateReloadedExtensionLoader('/tmp', {
        additionalSkillPaths: ['/skills/x'],
      });
      const b = await getOrCreateReloadedExtensionLoader('/tmp', {
        additionalSkillPaths: ['/skills/y'],
      });
      expect(a).not.toBe(b);
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });

    test('concurrent callers (same key) share a single in-flight reload (the documented invariant)', async () => {
      // Gate reload() so both callers are in-flight before either resolves — the
      // exact race two parallel same-layer DAG nodes hit. Caching the resolved
      // value instead of the Promise would construct/reload twice and fail this.
      let releaseReload: (() => void) | undefined;
      mockResourceLoaderReload.mockImplementationOnce(
        () =>
          new Promise<undefined>(resolve => {
            releaseReload = (): void => resolve(undefined);
          })
      );

      const p1 = getOrCreateReloadedExtensionLoader('/tmp', {});
      const p2 = getOrCreateReloadedExtensionLoader('/tmp', {});
      // Both subscribed before reload resolves.
      releaseReload?.();
      const [l1, l2] = await Promise.all([p1, p2]);

      expect(l1).toBe(l2);
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(1);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });

    test('a failed reload is evicted so the next call retries cleanly', async () => {
      mockResourceLoaderReload.mockImplementationOnce(async () => {
        throw new Error('broken extension');
      });

      await expect(getOrCreateReloadedExtensionLoader('/tmp', {})).rejects.toThrow(
        /Pi extension load failed: broken extension/
      );

      // Entry was evicted on failure → the retry constructs + reloads again
      // (rather than returning the poisoned rejected promise forever).
      mockResourceLoaderReload.mockImplementationOnce(async () => undefined);
      const loader = await getOrCreateReloadedExtensionLoader('/tmp', {});
      expect(loader).toBeDefined();
      expect(MockDefaultResourceLoader).toHaveBeenCalledTimes(2);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(2);
    });
  });

  // ─── extension provider registrations across sessions (issue #2064) ────
  //
  // Extension factories (e.g. pi-cursor's) run only during the single cached
  // reload() and queue their pi.registerProvider() calls on the loader's
  // shared runtime. The real SDK drains that queue into the FIRST session's
  // ModelRegistry and clears it — so before the fix, the 2nd+ sendQuery in a
  // process (DAG node 2) built a fresh registry that never saw extension
  // models and failed LOOKUP-2 with "Pi model not found".
  describe('extension provider registrations across sessions (issue #2064)', () => {
    /** Registration matching what pi-cursor queues at factory/load time. */
    const cursorRegistration = {
      name: 'cursor',
      config: {
        name: 'Cursor',
        baseUrl: 'http://localhost:33417/v1',
        apiKey: 'cursor-proxy',
        api: 'openai-completions',
        models: [],
      },
      extensionPath: '/mock/ext/pi-cursor',
    };

    /**
     * A per-call fake registry that resolves ONLY providers explicitly
     * registered into it — like the real one, whose static catalog does not
     * contain extension providers such as 'cursor'.
     */
    type ExtensionProviderConfig = Parameters<ModelRegistry['registerProvider']>[1];

    function fakeExtensionAwareRegistry(): MockModelRegistry & {
      registered: Map<string, ExtensionProviderConfig>;
    } {
      const registered = new Map<string, ExtensionProviderConfig>();
      return {
        registered,
        find: (provider: string, modelId: string) =>
          registered.has(provider) ? createMockModel(provider, modelId) : undefined,
        hasConfiguredAuth: mock(() => false),
        getApiKeyAndHeaders: mock(async () => ({ ok: true as const, apiKey: 'fake' })),
        registerProvider: ((name: string, config: ExtensionProviderConfig): void => {
          registered.set(name, config);
        }) as ModelRegistry['registerProvider'],
      };
    }

    /**
     * Simulate the real SDK's bindCore() drain for one createAgentSession
     * call: pi 0.84.0+ flushes the shared extension runtime's pending queue
     * into the SDK's INTERNAL registry, not ours — our provider re-applies
     * the snapshot separately (see `modelRegistry.registerProvider(name,
     * config)` in provider.ts). In this test the `bindCore` drain is a
     * no-op against our registry: the registrations land via the re-apply.
     * We just drain the queue so the second call's session sees an empty
     * queue (matching the SDK's behavior) — the source of truth is the
     * per-call registry re-apply.
     */
    function drainQueueOnceIntoSessionRegistry(): void {
      mockCreateAgentSession.mockImplementationOnce(
        async (_options?: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
          // The SDK drains the queue into ITS internal registry (built from
          // the same ModelRuntime); for our test we just need to clear the
          // shared queue so subsequent reloads don't replay it.
          mockLoaderRuntime.pendingProviderRegistrations = [];
          return createMockSessionResult();
        }
      );
    }

    test('extension-registered model resolves on the 2nd+ sendQuery (the issue #2064 scenario)', async () => {
      // The extension factory queued its registration during the single reload().
      mockLoaderRuntime.pendingProviderRegistrations = [cursorRegistration];

      const registries: ReturnType<typeof fakeExtensionAwareRegistry>[] = [];
      const nextRegistry = (): ReturnType<typeof fakeExtensionAwareRegistry> => {
        const registry = fakeExtensionAwareRegistry();
        registries.push(registry);
        return registry;
      };
      mockModelRegistryConstruct.mockImplementationOnce(() => nextRegistry());
      mockModelRegistryConstruct.mockImplementationOnce(() => nextRegistry());
      drainQueueOnceIntoSessionRegistry();
      drainQueueOnceIntoSessionRegistry();

      // Node 1: works with or without the fix (bindCore's drain registers cursor).
      resetScript(scriptedAgentEnd());
      const first = await consume(
        new PiProvider().sendQuery('a', '/tmp', undefined, { model: 'cursor/gpt-5.4-nano' })
      );
      expect(first.error).toBeUndefined();

      // Node 2: the queue is drained; only the loader-level snapshot re-apply
      // can register cursor into this call's fresh registry. Before the fix
      // this failed with "Pi model not found: provider='cursor'".
      resetScript(scriptedAgentEnd());
      const second = await consume(
        new PiProvider().sendQuery('b', '/tmp', undefined, { model: 'cursor/gpt-5.4-nano' })
      );
      expect(second.error).toBeUndefined();

      expect(registries).toHaveLength(2);
      expect(registries[1]?.registered.has('cursor')).toBe(true);
      // The extension model was resolved and set on both sessions.
      expect(mockSetModel).toHaveBeenCalledTimes(2);
      // Single-reload constraint (issue #1877) intact: no re-reload happened.
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });

    test('snapshot is captured before any session drains the shared queue and is served from cache', async () => {
      mockLoaderRuntime.pendingProviderRegistrations = [cursorRegistration];

      const entry = await getOrCreateReloadedExtensionLoader('/tmp', {});
      // Simulate the SDK's bindCore() drain (reassigns the runtime array).
      mockLoaderRuntime.pendingProviderRegistrations = [];

      expect(entry.providerRegistrations).toEqual([
        expect.objectContaining({ name: 'cursor', extensionPath: '/mock/ext/pi-cursor' }),
      ]);

      // Later nodes hit the cache and still see the captured registrations.
      const again = await getOrCreateReloadedExtensionLoader('/tmp', {});
      expect(again.providerRegistrations).toEqual(entry.providerRegistrations);
      expect(mockResourceLoaderReload).toHaveBeenCalledTimes(1);
    });

    test('a failing re-apply warns and does not fail nodes using other providers', async () => {
      process.env.GEMINI_API_KEY = 'sk-test';
      mockLoaderRuntime.pendingProviderRegistrations = [
        { name: 'broken', config: { baseUrl: 'http://x' }, extensionPath: '/mock/ext/broken' },
      ];
      // Static-catalog model resolves via the default find(); registerProvider
      // rejects the broken extension config — mirroring a validation throw.
      mockModelRegistryConstruct.mockImplementationOnce(() => ({
        find: mockModelRegistryFind,
        registerProvider: (): void => {
          throw new Error('Provider broken: "apiKey" or "oauth" is required when defining models.');
        },
      }));

      resetScript(scriptedAgentEnd());
      const { error } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'google/gemini-2.5-pro' })
      );

      expect(error).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          piExtensionProvider: 'broken',
          extensionPath: '/mock/ext/broken',
        }),
        'pi.extension_provider_reapply_failed'
      );
    });
  });
});
