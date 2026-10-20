import {
  mockLogger,
  mockSetModel,
  createMockSessionResult,
  mockCreateAgentSession,
  createMockModel,
  mockModelRegistryFind,
  type MockModelRuntime,
  mockModelRegistryConstruct,
  mockSettingsManagerDrainErrors,
  mockSettingsManagerGetGlobalSettings,
  mockSettingsManagerCreate,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import type { CreateAgentSessionResult } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { PiProvider } from './provider';
describe('PiProvider models', () => {
  test('reports a failure when no model is configured', async () => {
    const { failure } = await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(failure?.evidence).toContain('Pi provider requires a model');
  });

  test('preflight freezes the native default for the same model used by sendQuery', async () => {
    process.env.GEMINI_API_KEY = 'fixture-key';
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({
      defaultProvider: 'google',
      defaultModel: 'gemini-2.5-pro',
    }));
    const provider = new PiProvider();
    const model = await provider.resolveCredentialModel({ cwd: '/configuration-root' });
    expect(model).toBe('google/gemini-2.5-pro');
    expect(mockSettingsManagerCreate).toHaveBeenCalledWith('/configuration-root');
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({
      defaultProvider: 'anthropic',
      defaultModel: 'changed',
    }));
    for await (const _chunk of provider.sendQuery('test', '/execution-root', undefined, {
      model,
    })) {
      /* drain */
    }
    expect(mockCreateAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ provider: 'google', id: 'gemini-2.5-pro' }),
      })
    );
  });

  test('falls back to the operator Pi default (settings.json) when no model is configured', async () => {
    // With no node/config model, Archon composes the operator's Pi default
    // (defaultProvider/defaultModel) so no vendor model is hardcoded — e.g. a
    // litellm-only setup boots on its own configured default model.
    process.env.GEMINI_API_KEY = 'sk-test';
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({
      defaultProvider: 'google',
      defaultModel: 'gemini-2.5-pro',
    }));
    resetScript(scriptedAgentEnd());

    // No `model` in the request options — must resolve from settings.
    const { error } = await consume(new PiProvider().sendQuery('hi', '/tmp'));

    expect(error).toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { modelRef: 'google/gemini-2.5-pro' },
      'pi.model_defaulted_from_settings'
    );
    expect(mockModelRegistryFind).toHaveBeenCalledWith('google', 'gemini-2.5-pro');
  });

  test('still reports a failure when no model and settings default is incomplete (provider without model)', async () => {
    // A partial default (provider set but no model, or vice versa) must NOT
    // silently resolve — fail fast with the actionable "requires a model" error.
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({
      defaultProvider: 'google',
    }));
    const { failure } = await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(failure?.evidence).toContain('Pi provider requires a model');
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'pi.model_defaulted_from_settings'
    );
  });

  test('drains and logs settings errors when falling through the missing-model path', async () => {
    // A malformed/unreadable settings.json is recorded via drainErrors() (not
    // thrown) and yields empty defaults. The error must be surfaced, not
    // swallowed behind the "requires a model" throw below.
    mockSettingsManagerGetGlobalSettings.mockImplementation(() => ({}));
    mockSettingsManagerDrainErrors.mockImplementation(() => [
      { scope: 'global', error: new Error('bad settings.json') },
    ]);
    const { failure } = await consume(new PiProvider().sendQuery('hi', '/tmp'));
    expect(failure?.evidence).toContain('Pi provider requires a model');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global' }),
      'pi.settings_default_model_read_error'
    );
  });

  test('reports a failure when model ref is malformed', async () => {
    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, { model: 'sonnet' })
    );
    expect(failure?.class).toBe('misconfigured');
    expect(failure?.evidence).toContain('Invalid Pi model ref');
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
        // The models.json load error means Pi has no provider entry to resolve.
        getProvider: () => undefined,
        hasConfiguredAuth: mock((model: Model<Api>) => r.hasConfiguredAuth(model.provider)),
        getApiKeyAndHeaders: mock(async () => ({ ok: true as const })),
        getError: () => 'Provider lm-studio: "baseUrl" is required when defining custom models.',
      };
    });

    resetScript(scriptedAgentEnd());
    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'lm-studio/some-model',
      })
    );

    expect(failure?.class).toBe('misconfigured');
    expect(failure?.evidence).toContain('Pi model not found');
    expect(failure?.evidence).toContain('pi update --models');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        piProvider: 'lm-studio',
        modelId: 'some-model',
        loadError: expect.stringContaining('"baseUrl" is required'),
      }),
      'pi.model_registry_load_error'
    );
  });

  test('reports a failure when ModelRegistry.find returns undefined', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = '/custom/pi-agent';
    // find() is called twice — first on the static catalog, then again after bindExtensions()
    // resolves extension providers. Both must return undefined to trigger the error.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    resetScript(scriptedAgentEnd());
    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/unknown-model-id',
      })
    );
    // A known provider with an unknown model id is a stale catalog, not a
    // missing provider extension, so the extension remedy must not appear.
    expect(failure?.evidence).toContain('Pi model not found');
    expect(failure?.evidence).toContain('pi update --models');
    expect(failure?.evidence).toContain(join('/custom/pi-agent', 'models-store.json'));
    expect(failure?.evidence).not.toContain('provider extension');
    expect(failure?.evidence).not.toContain('enableExtensions');
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  test('unknown provider points at the provider extension remedy', async () => {
    // `nonexistent` is the one provider the mock registry does not know, so
    // this is the missing-extension case rather than a stale catalog.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    resetScript(scriptedAgentEnd());
    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'nonexistent/some-model',
      })
    );
    expect(failure?.evidence).toContain('Pi model not found');
    expect(failure?.evidence).toContain('provider extension');
    expect(failure?.evidence).toContain('enableExtensions: true');
    expect(failure?.evidence).toContain('pi update --models');
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

  test('an Anthropic model outside the static catalog with no stored login reaches the extensions', async () => {
    // An extension may register the model and manage its credential outside Pi's store.
    mockModelRegistryFind.mockImplementationOnce(() => undefined);
    mockModelRegistryFind.mockImplementationOnce(() =>
      createMockModel('anthropic', 'extension-model')
    );
    resetScript(scriptedAgentEnd());

    const { error, failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/extension-model',
      })
    );

    expect(error).toBeUndefined();
    expect(failure).toBeUndefined();
    expect(mockSetModel).toHaveBeenCalledTimes(1);
  });

  test('modelFallbackMessage yields a pi.model_fallback warning before the agent runs', async () => {
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
    const warnings = chunks.filter(
      (c): c is { type: 'warning'; code: string; message: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'warning'
    );
    expect(
      warnings.some(
        c => c.code === 'pi.model_fallback' && c.message.includes('sonnet-5 not available')
      )
    ).toBe(true);
  });
});
