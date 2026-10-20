import { removeTempTree } from '@archon/paths/test-utils';
import {
  mockLogger,
  capturedListener,
  scriptedEvents,
  mockPrompt,
  mockBindExtensions,
  mockCreateAgentSession,
  mockSetRuntimeApiKey,
  mockGetAuth,
  mockCheckAuth,
  mockHasConfiguredAuth,
  createMockModel,
  type MockModelRegistry,
  mockModelRegistryConstruct,
  mockModelRuntimeCreate,
  consume,
  resetScript,
  scriptedAgentEnd,
} from './provider-test-fixture';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { PiProvider } from './provider';
describe('PiProvider custom models', () => {
  test('custom provider: per-call models.json carries substituted ${VAR} values', async () => {
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

    // The provider removes the per-call file at turn end; capture it while the runtime loads.
    let capturedPerCallContent: string | undefined;
    mockModelRuntimeCreate.mockImplementationOnce(async options => {
      if (options?.modelsPath && existsSync(options.modelsPath)) {
        capturedPerCallContent = readFileSync(options.modelsPath, 'utf-8');
      }
      return {
        checkAuth: mockCheckAuth,
        getModels: () => [createMockModel('google', 'gemini-2.5-pro')],
        setRuntimeApiKey: mockSetRuntimeApiKey,
        getAuth: mockGetAuth,
        hasConfiguredAuth: mockHasConfiguredAuth,
        getProviderAuthStatus: () => ({ configured: false }),
        listCredentials: async () => [],
      };
    });

    resetScript(scriptedAgentEnd());
    let createArgs: Parameters<typeof mockModelRuntimeCreate>[0];
    try {
      await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: {
            MYGW_API_KEY: 'request-secret',
            MYGW_PROJECT: 'project-123',

            ANTHROPIC_API_KEY: 'acting-user-secret',
          },
          protectedEnvKeys: ['ANTHROPIC_API_KEY'],
        })
      );

      expect(mockModelRuntimeCreate).toHaveBeenCalledTimes(1);
      createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0];
      expect(createArgs?.modelsPath).toBeDefined();
      expect(createArgs?.modelsPath).not.toBe(userModelsPath);

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

      const requestRegistry = mockModelRegistryConstruct.mock.results[0]?.value as
        | MockModelRegistry
        | undefined;

      expect(requestRegistry?.getApiKeyAndHeaders).toBeDefined();

      expect(requestRegistry?.getApiKeyAndHeaders).not.toHaveBeenCalled();
    } finally {
      if (createArgs?.modelsPath && existsSync(createArgs.modelsPath)) {
        rmSync(createArgs.modelsPath, { force: true });
      }
      await removeTempTree(userModelsDir);
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  /**
   * Point PI_CODING_AGENT_DIR at a scratch models.json whose `provider` entry
   * has a `${MYGW_API_KEY}` apiKey, so sendQuery writes a per-call file.
   */
  async function withTemplatedUserModels(
    provider: string,
    run: () => Promise<void>
  ): Promise<void> {
    const userModelsDir = mkdtempSync(join(tmpdir(), 'archon-pi-test-user-models-lifetime-'));
    writeFileSync(
      join(userModelsDir, 'models.json'),
      JSON.stringify({
        providers: {
          [provider]: {
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
    try {
      await run();
    } finally {
      const perCallPath = mockModelRuntimeCreate.mock.calls[0]?.[0]?.modelsPath;
      if (perCallPath) rmSync(perCallPath, { force: true });
      await removeTempTree(userModelsDir);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }

  function perCallModelsPath(): string {
    const createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0];
    expect(createArgs?.modelsPath).toBeDefined();
    return createArgs?.modelsPath as string;
  }

  test('custom provider: per-call models.json lives until the session ends', async () => {
    let existedDuringPrompt: boolean | undefined;
    mockPrompt.mockImplementationOnce(async () => {
      existedDuringPrompt = existsSync(perCallModelsPath());
      for (const ev of scriptedEvents) capturedListener?.(ev);
    });
    resetScript(scriptedAgentEnd());
    await withTemplatedUserModels('mygw', async () => {
      const { failure } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: { MYGW_API_KEY: 'request-secret' },
          protectedEnvKeys: [],
        })
      );
      expect(failure).toBeUndefined();
      expect(existedDuringPrompt).toBe(true);
      expect(existsSync(perCallModelsPath())).toBe(false);
    });
  });

  test.each([
    {
      exit: 'a model lookup miss',
      provider: 'nonexistent',
      arrange: (): void => undefined,
      abortSignal: undefined,
      sessions: 1,
    },
    {
      exit: 'a model registry construction failure',
      provider: 'mygw',
      arrange: (): void => {
        mockModelRegistryConstruct.mockImplementationOnce(() => {
          throw new Error('registry construction failed');
        });
      },
      abortSignal: undefined,
      sessions: 0,
    },
    {
      exit: 'an extension failure',
      provider: 'mygw',
      arrange: (): void => {
        mockBindExtensions.mockImplementationOnce(async () => {
          throw new Error('extension failed to bind');
        });
      },
      abortSignal: undefined,
      sessions: 1,
    },
    {
      exit: 'cancellation',
      provider: 'mygw',
      arrange: (): void => undefined,
      abortSignal: AbortSignal.abort(),
      sessions: 0,
    },
  ])('custom provider: per-call models.json is removed after $exit', async c => {
    c.arrange();
    resetScript(scriptedAgentEnd());
    await withTemplatedUserModels(c.provider, async () => {
      const { failure, error } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: `${c.provider}/demo`,
          env: { MYGW_API_KEY: 'request-secret' },
          protectedEnvKeys: [],
          abortSignal: c.abortSignal,
        })
      );
      expect(failure ?? error).toBeDefined();
      expect(mockCreateAgentSession).toHaveBeenCalledTimes(c.sessions);
      expect(existsSync(perCallModelsPath())).toBe(false);
    });
  });

  test('custom provider: per-call models.json is unlinked even when ModelRuntime.create throws', async () => {
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

    mockModelRuntimeCreate.mockImplementationOnce(async options => {
      expect(options?.modelsPath).toBeDefined();
      expect(existsSync(options!.modelsPath!)).toBe(true);
      throw new Error('simulated SDK failure');
    });

    try {
      const { failure } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: { MYGW_API_KEY: 'request-secret' },
          protectedEnvKeys: [],
        })
      );
      expect(failure?.class).toBe('unknown');
      expect(failure?.evidence).toContain('Pi auth storage init failed');
      expect(failure?.evidence).toContain('simulated SDK failure');

      const createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0];
      expect(createArgs?.modelsPath).toBeDefined();

      expect(existsSync(createArgs!.modelsPath as string)).toBe(false);
    } finally {
      await removeTempTree(userModelsDir);
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });

  test('custom provider: filesystem error from buildCustomProviderModelsPath is classified as Pi auth storage init failed', async () => {
    // A file occupying the directory path provokes a real FS error on every platform.
    const scratchTmp = mkdtempSync(join(tmpdir(), 'archon-pi-test-tmp-eexist-'));
    writeFileSync(join(scratchTmp, 'archon-pi-models'), 'file-occupying-the-dir-path');

    const userModelsDir = mkdtempSync(join(tmpdir(), 'archon-pi-test-user-models-fserror-'));
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
    const previousTmpDir = process.env.TMPDIR;
    const previousTmp = process.env.TMP;
    const previousTemp = process.env.TEMP;
    process.env.PI_CODING_AGENT_DIR = userModelsDir;

    // node:os uses different temp-directory keys on POSIX and Windows.
    process.env.TMPDIR = scratchTmp;
    process.env.TMP = scratchTmp;
    process.env.TEMP = scratchTmp;

    try {
      const { failure } = await consume(
        new PiProvider().sendQuery('hi', '/tmp', undefined, {
          model: 'mygw/demo',
          env: { MYGW_API_KEY: 'request-secret' },
          protectedEnvKeys: [],
        })
      );

      expect(failure?.class).toBe('unknown');
      expect(failure?.evidence).toContain('Pi auth storage init failed');
      expect(failure?.evidence).toMatch(/EEXIST|file already exists/);
      expect(failure?.evidence).toContain('~/.pi/agent/auth.json');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ piProvider: 'mygw' }),
        'pi.auth_storage_init_failed'
      );

      expect(mockModelRuntimeCreate).not.toHaveBeenCalled();
    } finally {
      await removeTempTree(scratchTmp);
      await removeTempTree(userModelsDir);
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      if (previousTmpDir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpDir;
      }
      if (previousTmp === undefined) {
        delete process.env.TMP;
      } else {
        process.env.TMP = previousTmp;
      }
      if (previousTemp === undefined) {
        delete process.env.TEMP;
      } else {
        process.env.TEMP = previousTemp;
      }
    }
  });

  test('custom provider: no ${VAR} references leaves modelsPath unset', async () => {
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
      const createArgs = mockModelRuntimeCreate.mock.calls[0]?.[0];

      expect(createArgs?.modelsPath).toBeUndefined();
    } finally {
      await removeTempTree(userModelsDir);
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });
});
