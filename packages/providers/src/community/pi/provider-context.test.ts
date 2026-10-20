import {
  mockLogger,
  fileCreds,
  mockSetRuntimeApiKey,
  mockSettingsManagerDrainErrors,
  mockSettingsManagerGetGlobalSettings,
  mockSettingsManagerGetProjectSettings,
  mockSettingsManagerCreate,
  mockSettingsManagerInMemory,
  MockDefaultResourceLoader,
  consume,
  resetScript,
  readEnv,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { describe, expect, test } from 'bun:test';
import { PiProvider } from './provider';
describe('PiProvider context', () => {
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
    expect(loaderArgs).not.toHaveProperty('noContextFiles');
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

  test('appendSystemPrompt becomes the session system prompt when nothing replaces it', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        appendSystemPrompt: 'orchestrator instructions',
      })
    );

    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBe('orchestrator instructions');
  });

  test('string[] systemPrompt is dropped with warning', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: ['part one', 'part two'],
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
    // Regression: a non-string request-level prompt (string[]) must NOT win
    // via `??` and shadow a valid node-level string — each level is validated
    // independently before precedence applies.
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'google/gemini-2.5-pro',
        systemPrompt: ['part one', 'part two'],
        nodeConfig: { systemPrompt: 'node-level prompt' },
      })
    );

    // The dropped request-level array is reported, tagged with its source.
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

  test("a user's own Pi Anthropic login is used as Pi configures it, with no Archon prompt", async () => {
    fileCreds.anthropic = { type: 'oauth' };
    resetScript(scriptedAgentEnd());

    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );

    expect(failure).toBeUndefined();
    const loaderArgs = MockDefaultResourceLoader.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(loaderArgs?.systemPrompt).toBeUndefined();
  });

  test('Anthropic API-key session runs with Pi built-in prompt (systemPrompt undefined)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-key';
    resetScript(scriptedAgentEnd());

    const { failure } = await consume(
      new PiProvider().sendQuery('hi', '/tmp', undefined, {
        model: 'anthropic/claude-haiku-4-5',
      })
    );

    expect(failure).toBeUndefined();
    expect(mockSetRuntimeApiKey).toHaveBeenCalledWith('anthropic', 'sk-ant-api03-key');

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

  test('nodeConfig.skills with unknown name yields a warning, does not abort', async () => {
    process.env.GEMINI_API_KEY = 'sk-test';
    resetScript(scriptedAgentEnd());

    const { chunks, error } = await consume(
      new PiProvider().sendQuery('hi', '/tmp/nonexistent-cwd', undefined, {
        model: 'google/gemini-2.5-pro',
        nodeConfig: { skills: ['definitely-does-not-exist'] },
      })
    );
    expect(error).toBeUndefined();
    const warnings = chunks.filter(
      (c): c is { type: 'warning'; code: string; message: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'warning'
    );
    expect(
      warnings.some(
        c => c.code === 'pi.skills_unresolved' && c.message.includes('definitely-does-not-exist')
      )
    ).toBe(true);

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
});
