// @archon-test-isolated
import { platformStreamingSchema } from './config-types';
import { clearPlatformPolicies, setPlatformPolicies } from '../platforms/registry';
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import {
  loadGlobalConfig,
  loadRepoConfig,
  loadConfig,
  clearConfigCache,
  toSafeConfig,
  updateGlobalConfig,
} from './config-loader';
import { InvalidConfigError } from './config-validation';
import {
  mockLogger,
  archonHome,
  mockFsReadFile,
  mockFsWriteFile,
  streamtestPolicy,
  matrixPolicy,
  useConfigTestEnv,
} from './test-harness';

describe('config-loader', () => {
  useConfigTestEnv();

  test('new and unregistered streaming keys survive load, merge, update and safe projection', async () => {
    setPlatformPolicies([streamtestPolicy, matrixPolicy]);
    mockFsReadFile.mockResolvedValue('streaming:\n  matrix-chat: batch\n  other-chat: stream\n');
    expect((await loadGlobalConfig()).streaming).toEqual({
      'matrix-chat': 'batch',
      'other-chat': 'stream',
    });
    const config = await loadConfig();
    expect(toSafeConfig(config).streaming).toEqual({
      streamtest: 'stream',
      'matrix-chat': 'batch',
      'other-chat': 'stream',
    });
    await updateGlobalConfig({ streaming: { 'matrix-chat': 'stream' } });
    const written = Bun.YAML.parse(mockFsWriteFile.mock.calls[0]?.[1] as string) as {
      streaming: unknown;
    };
    expect(platformStreamingSchema.parse(written.streaming)).toEqual({
      'matrix-chat': 'stream',
      'other-chat': 'stream',
    });
  });

  test('invalid streaming keys or modes refuse to load and never reach the file', async () => {
    mockFsReadFile.mockResolvedValue('streaming:\n  Not A Platform: stream\n  streamtest: fast\n');
    await expect(loadGlobalConfig()).rejects.toThrow('Invalid streaming config');
    await expect(updateGlobalConfig({ streaming: { 'matrix-chat': 'stream' } })).rejects.toThrow(
      'Invalid streaming config'
    );
    expect(mockFsWriteFile).not.toHaveBeenCalled();
  });

  test('attention notice routes load from global config only', async () => {
    const routes = 'attentionNotices:\n  - platform: matrix-chat\n    destination: ops\n';
    mockFsReadFile.mockImplementation(async (path: string) =>
      path.replace(/\\/g, '/').includes('/repo/.archon/')
        ? 'attentionNotices:\n  - platform: repo-chat\n    destination: repo\n'
        : routes
    );
    expect((await loadConfig('/repo')).attentionNotices).toEqual([
      { platform: 'matrix-chat', destination: 'ops' },
    ]);
    expect(toSafeConfig(await loadConfig())).not.toHaveProperty('attentionNotices');
  });

  test.each([
    'attentionNotices:\n  - platform: matrix-chat\n    destination: ops\n  - platform: matrix-chat\n    destination: ops\n',
    'attentionNotices:\n  - platform: matrix-chat\n    destination: ""\n',
    'attentionNotices:\n  - platform: Matrix Chat\n    destination: ops\n',
  ])('an invalid attention notice route refuses to load: %s', async yaml => {
    mockFsReadFile.mockResolvedValue(yaml);
    await expect(loadConfig()).rejects.toThrow('Invalid attentionNotices config');
  });

  test.each(['concurrency:', 'concurrency: null', 'concurrency: ~'])(
    '%s preserves unrelated global settings and the default conversation limit',
    async concurrency => {
      mockFsReadFile.mockResolvedValue(`botName: MyBot\n${concurrency}\n`);
      const config = await loadConfig();
      expect(config.botName).toBe('MyBot');
      expect(config.concurrency.maxConversations).toBe(10);
    }
  );

  test.each(['concurrency:', 'concurrency: null', 'concurrency: ~'])(
    '%s allows unrelated global settings updates',
    async concurrency => {
      mockFsReadFile.mockResolvedValue(`botName: MyBot\n${concurrency}\n`);
      await updateGlobalConfig({ botName: 'UpdatedBot' });
      expect(Bun.YAML.parse(mockFsWriteFile.mock.calls[0]?.[1] as string)).toEqual({
        botName: 'UpdatedBot',
        concurrency: null,
      });
    }
  );

  test('invalid conversation limits refuse to load and cannot be persisted', async () => {
    mockFsReadFile.mockResolvedValue('concurrency:\n  maxConversations: -1\n');
    await expect(loadConfig()).rejects.toThrow(/Invalid concurrency config.*maxConversations/);
    await expect(updateGlobalConfig({ defaultAssistant: 'claude' })).rejects.toThrow(
      /Invalid concurrency config.*maxConversations/
    );
    expect(mockFsWriteFile).not.toHaveBeenCalled();
    await updateGlobalConfig({ concurrency: { maxConversations: 3 } });
    expect(Bun.YAML.parse(mockFsWriteFile.mock.calls[0]?.[1] as string)).toEqual({
      concurrency: { maxConversations: 3 },
    });
  });

  test('registered streaming default and validated environment override apply', async () => {
    setPlatformPolicies([streamtestPolicy, matrixPolicy]);
    mockFsReadFile.mockResolvedValue('');
    expect((await loadConfig()).streaming['matrix-chat']).toBe('stream');
    process.env.MATRIX_STREAMING_MODE = 'batch';
    clearConfigCache();
    expect((await loadConfig()).streaming['matrix-chat']).toBe('batch');
    process.env.MATRIX_STREAMING_MODE = 'invalid';
    clearConfigCache();
    expect((await loadConfig()).streaming['matrix-chat']).toBe('stream');
  });

  test('loading config fails until the host configures platform policies', async () => {
    clearPlatformPolicies();
    mockFsReadFile.mockResolvedValue('');
    await expect(loadConfig()).rejects.toThrow('Platform policies are not configured');
  });

  describe('loadGlobalConfig', () => {
    test('returns empty object when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadGlobalConfig();
      expect(config).toEqual({});
    });

    test('parses valid YAML config', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: codex
streaming:
  telegram: batch
concurrency:
  maxConversations: 5
`);

      const config = await loadGlobalConfig();
      expect(config.defaultAssistant).toBe('codex');
      expect(config.streaming?.telegram).toBe('batch');
      expect(config.concurrency?.maxConversations).toBe(5);
    });

    test.each([
      ['tiers', 'medium'],
      ['aliases', "'@deep'"],
    ] as const)(
      'rejects retired thinking in global %s config and names effort',
      async (field, entry) => {
        mockFsReadFile.mockResolvedValue(`
${field}:
  ${entry}: { provider: claude, model: opus, thinking: adaptive }
`);

        const error = (await loadGlobalConfig().catch(err => err)) as Error;

        expect(error.message).toContain(join(archonHome, 'config.yaml'));
        expect(error.message).toMatch(new RegExp(`${field}\\..*thinking.*effort:`));
      }
    );

    test.each([0, 60000])('accepts tool attention policy %s at config ingress', async threshold => {
      mockFsReadFile.mockResolvedValue(`workflows:\n  toolCallAttentionMs: ${threshold}\n`);
      expect((await loadGlobalConfig()).workflows?.toolCallAttentionMs).toBe(threshold);
    });

    test.each([-1, 1.5])(
      'rejects invalid tool attention policy %s at config ingress',
      async threshold => {
        mockFsReadFile.mockResolvedValue(`workflows:\n  toolCallAttentionMs: ${threshold}\n`);
        await expect(loadGlobalConfig()).rejects.toThrow('Invalid workflows config');
      }
    );

    test('rejects malformed quota continuation policy at config ingress', async () => {
      mockFsReadFile.mockResolvedValue(`
workflows:
  autoResumeOnQuotaReset: yes
  quotaMaxAttempts: 1.5
  quotaDeadlineMs: -1
`);

      await expect(loadGlobalConfig()).rejects.toThrow('Invalid workflows config');
    });

    test('rejects quota continuation delays beyond the persisted timestamp range', async () => {
      mockFsReadFile.mockResolvedValue(`
workflows:
  quotaFallbackDelayMs: 31536000000001
  quotaDeadlineMs: 31536000000001
`);

      await expect(loadGlobalConfig()).rejects.toThrow('Invalid workflows config');
    });

    test('parses deprecated quota settings at the persisted timestamp bound, with a warning', async () => {
      mockFsReadFile.mockResolvedValue(`
workflows:
  quotaFallbackDelayMs: 31536000000000
  quotaDeadlineMs: 31536000000000
`);

      const config = await loadGlobalConfig();

      expect(config.workflows).toEqual({
        quotaFallbackDelayMs: 31_536_000_000_000,
        quotaDeadlineMs: 31_536_000_000_000,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          warning: expect.stringContaining(
            'workflows.quotaFallbackDelayMs, workflows.quotaDeadlineMs are deprecated and have no effect'
          ),
        }),
        'config.workflows_quota_keys_deprecated'
      );
    });

    test('keeps ordinary config forward-compatible with unknown workflow settings', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: codex
workflows:
  autoResumeOnQuotaReset: true
  futurePolicy: enabled
`);

      const config = await loadGlobalConfig();

      expect(config.defaultAssistant).toBe('codex');
      expect(config.workflows).toEqual({ autoResumeOnQuotaReset: true });
    });

    test('caches config on subsequent calls', async () => {
      mockFsReadFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig();

      // Should only read file once
      expect(mockFsReadFile).toHaveBeenCalledTimes(1);
    });

    test('reloads config when forceReload is true', async () => {
      mockFsReadFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig(true);

      expect(mockFsReadFile).toHaveBeenCalledTimes(2);
    });

    test('invalid YAML fails the load and names the file', async () => {
      mockFsReadFile.mockResolvedValue('worktree: [');

      const error = (await loadGlobalConfig().catch(err => err)) as Error;

      expect(error.message).toContain(join(archonHome, 'config.yaml'));
      expect(error.message).toContain('not valid YAML');
    });

    test('an unreadable config fails the load', async () => {
      const permError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      mockFsReadFile.mockRejectedValue(permError);

      await expect(loadGlobalConfig()).rejects.toBe(permError);
    });

    test.each(['false', '[]'])(
      'a top level that is not a mapping fails the load: %s',
      async content => {
        mockFsReadFile.mockResolvedValue(content);

        const error = (await loadGlobalConfig().catch(err => err)) as Error;

        expect(error.message).toContain(join(archonHome, 'config.yaml'));
        expect(error.message).toContain('not a map of settings');
      }
    );
  });

  describe('loadRepoConfig', () => {
    test('loads post-create commands and per-command timeout', async () => {
      mockFsReadFile.mockResolvedValue(
        'worktree:\n  postCreate: ["  bun install  ", "./setup.sh"]\n  postCreateTimeout: 75000'
      );
      expect((await loadRepoConfig('/repo')).worktree).toEqual({
        postCreate: ['  bun install  ', './setup.sh'],
        postCreateTimeout: 75000,
      });
    });

    test.each([
      'postCreate: false',
      'postCreate: [42]',
      'postCreate: [" "]',
      'postCreateTimeout: 0',
      'postCreateTimeout: -1',
      'postCreateTimeout: 1.5',
      'postCreateTimeout: "300000"',
      'postCreateTimeout: .inf',
    ])('rejects invalid provisioning setting: %s', async setting => {
      mockFsReadFile.mockResolvedValue(`worktree:\n  ${setting}`);
      await expect(loadRepoConfig('/repo')).rejects.toThrow('worktree.postCreate');
    });

    test('loads from .archon/config.yaml', async () => {
      mockFsReadFile.mockResolvedValue('assistant: codex');

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('returns empty object when no config found', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadRepoConfig('/test/repo');
      expect(config).toEqual({});
    });

    test.each([
      ['tiers', 'medium'],
      ['aliases', "'@deep'"],
    ] as const)(
      'rejects retired thinking in repository %s config and names effort',
      async (field, entry) => {
        mockFsReadFile.mockResolvedValue(`
assistant: codex
${field}:
  ${entry}: { provider: claude, model: opus, thinking: adaptive }
`);

        const error = (await loadRepoConfig('/test/repo').catch(err => err)) as Error;

        expect(error.message).toContain(join('/test/repo', '.archon', 'config.yaml'));
        expect(error.message).toMatch(new RegExp(`${field}\\..*thinking.*effort:`));
      }
    );

    test('invalid YAML fails the load and names the file', async () => {
      mockFsReadFile.mockResolvedValue('worktree: [');

      const error = (await loadRepoConfig('/test/repo').catch(err => err)) as Error;

      expect(error.message).toContain(join('/test/repo', '.archon', 'config.yaml'));
      expect(error.message).toContain('not valid YAML');
    });

    test('an unreadable config fails the load', async () => {
      const permError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      mockFsReadFile.mockRejectedValue(permError);

      await expect(loadRepoConfig('/test/repo')).rejects.toBe(permError);
    });

    test.each(['false', '[]'])(
      'a top level that is not a mapping fails the load: %s',
      async content => {
        mockFsReadFile.mockResolvedValue(content);
        await expect(loadRepoConfig('/repo')).rejects.toThrow(/not a map of settings/);
      }
    );

    test('parses recommendedWorkflows as an ordered string array', async () => {
      mockFsReadFile.mockResolvedValue(`
recommendedWorkflows:
  - archon-ship
  - archon-deliver
  - archon-plan
`);

      const config = await loadRepoConfig('/test/repo');

      expect(config.recommendedWorkflows).toEqual(['archon-ship', 'archon-deliver', 'archon-plan']);
    });

    test('omits recommendedWorkflows when key is absent', async () => {
      mockFsReadFile.mockResolvedValue('assistant: codex');

      const config = await loadRepoConfig('/test/repo');

      expect(config.recommendedWorkflows).toBeUndefined();
    });

    test('trims entries and drops non-strings / empties without throwing', async () => {
      mockFsReadFile.mockResolvedValue(`
recommendedWorkflows:
  - "  archon-plan  "
  - ""
  - 42
  - archon-ship
`);

      const config = await loadRepoConfig('/test/repo');

      expect(config.recommendedWorkflows).toEqual(['archon-plan', 'archon-ship']);
    });

    test('coerces non-array recommendedWorkflows to undefined without throwing', async () => {
      mockFsReadFile.mockResolvedValue(`
recommendedWorkflows: "archon-plan"
`);

      const config = await loadRepoConfig('/test/repo');

      expect(config.recommendedWorkflows).toBeUndefined();
    });
  });

  describe('settingSources config', () => {
    test('merges settingSources from global config', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  claude:
    settingSources:
      - project
      - user
`);
      const config = await loadConfig();
      expect(config.assistants.claude.settingSources).toEqual(['project', 'user']);
    });

    test('defaults to undefined settingSources when not configured', async () => {
      mockFsReadFile.mockResolvedValue('');
      const config = await loadConfig();
      expect(config.assistants.claude.settingSources).toBeUndefined();
    });

    test('repo settingSources overrides global', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `assistants:\n  claude:\n    settingSources:\n      - project\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return `assistants:\n  claude:\n    settingSources:\n      - project\n      - user\n`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistants.claude.settingSources).toEqual(['project']);
    });

    test('toSafeConfig does not expose settingSources (server-internal field)', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  claude:
    settingSources:
      - project
      - user
`);
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe.assistants.claude).not.toHaveProperty('settingSources');
    });
  });

  describe('updateGlobalConfig', () => {
    test('merges assistant config into existing file', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: claude
assistants:
  claude:
    model: sonnet
`);

      await updateGlobalConfig({
        assistants: { claude: { model: 'opus' } },
      });

      expect(mockFsWriteFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('opus');
    });

    test('preserves existing non-updated fields', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: codex
botName: MyBot
assistants:
  codex:
    model: gpt-5.6-sol
    modelReasoningEffort: medium
`);

      await updateGlobalConfig({
        defaultAssistant: 'claude',
      });

      expect(mockFsWriteFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('claude');
      expect(writtenContent).toContain('MyBot');
    });

    test('merges workflow continuation policy into the persisted config', async () => {
      mockFsReadFile.mockResolvedValue(`
workflows:
  autoResumeOnQuotaReset: false
  quotaMaxAttempts: 2
`);

      await updateGlobalConfig({
        workflows: { autoResumeOnQuotaReset: true, quotaFallbackDelayMs: 60_000 },
      });

      const writtenContent = mockFsWriteFile.mock.calls[0]?.[1] as string;
      const written = Bun.YAML.parse(writtenContent) as {
        workflows?: Record<string, unknown>;
      };
      expect(written.workflows).toEqual({
        autoResumeOnQuotaReset: true,
        quotaMaxAttempts: 2,
        quotaFallbackDelayMs: 60_000,
      });
    });

    test('creates config when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      await updateGlobalConfig({
        defaultAssistant: 'codex',
      });

      expect(mockFsWriteFile).toHaveBeenCalled();
      const writtenContent = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('codex');
    });

    test('throws on permission errors', async () => {
      mockFsReadFile.mockResolvedValue('');
      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockFsWriteFile.mockRejectedValue(permError);

      await expect(updateGlobalConfig({ defaultAssistant: 'codex' })).rejects.toThrow(
        'Permission denied'
      );
    });

    test('sets a model tier', async () => {
      mockFsReadFile.mockResolvedValue('defaultAssistant: claude\n');
      await updateGlobalConfig({ tiers: { large: { provider: 'claude', model: 'opus' } } });
      const written = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(written).toContain('tiers');
      expect(written).toContain('opus');
    });

    test('per-tier merge: setting one tier preserves the others', async () => {
      mockFsReadFile.mockResolvedValue(`
tiers:
  small:
    provider: claude
    model: haiku
`);
      await updateGlobalConfig({ tiers: { large: { provider: 'codex', model: 'gpt-5.5' } } });
      const written = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(written).toContain('haiku'); // small preserved
      expect(written).toContain('gpt-5.5'); // large added
    });

    test('null tier value unsets that tier', async () => {
      mockFsReadFile.mockResolvedValue(`
tiers:
  large:
    provider: claude
    model: opus
`);
      await updateGlobalConfig({ tiers: { large: null } });
      const written = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(written).not.toContain('opus');
    });

    test('unsetting every tier collapses `tiers` to undefined (no empty tiers key)', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: claude
tiers:
  large:
    provider: claude
    model: opus
`);
      await updateGlobalConfig({ tiers: { small: null, medium: null, large: null } });
      const written = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(written).not.toContain('opus');
      // Collapsed to `undefined` → no serialized `tiers:` key at all.
      expect(written).not.toMatch(/^tiers:/m);
    });

    test('existing tiers survive an assistants-only update', async () => {
      mockFsReadFile.mockResolvedValue(`
tiers:
  large:
    provider: claude
    model: opus
assistants:
  claude:
    model: sonnet
`);
      await updateGlobalConfig({ assistants: { claude: { model: 'haiku' } } });
      const written = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(written).toContain('opus'); // tiers preserved via the {...current} spread
      expect(written).toContain('haiku');
    });
  });

  // The loaders refuse a file with an invalid `tiers`/`aliases`/`workflows`
  // block; a settings write must merge into what is actually on disk so it can
  // repair the block without replacing the rest of the file.
  describe('updateGlobalConfig over an invalid file', () => {
    const fileWithBadTier = `
botName: MyBot
defaultAssistant: codex
streaming:
  telegram: batch
tiers:
  large:
    provider: claude
aliases:
  fast:
    provider: claude
    model: haiku
`;

    test('refuses an unrelated edit that leaves an invalid tier in place', async () => {
      mockFsReadFile.mockResolvedValue(fileWithBadTier);

      await expect(
        updateGlobalConfig({ aliases: { deep: { provider: 'claude', model: 'opus' } } })
      ).rejects.toThrow(/Invalid model binding config.*tiers\.large\.model/);
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('a patch that repairs the invalid tier keeps every unrelated key', async () => {
      mockFsReadFile.mockResolvedValue(fileWithBadTier);

      await updateGlobalConfig({ tiers: { large: { provider: 'claude', model: 'opus' } } });

      const written = Bun.YAML.parse(mockFsWriteFile.mock.calls[0]?.[1] as string);
      expect(written).toEqual({
        botName: 'MyBot',
        defaultAssistant: 'codex',
        streaming: { telegram: 'batch' },
        tiers: { large: { provider: 'claude', model: 'opus' } },
        aliases: { fast: { provider: 'claude', model: 'haiku' } },
      });
    });

    // The tier merge must not rebuild the block from the known tier names only,
    // which would silently drop an entry it cannot represent.
    test('a tier edit does not silently drop an unknown tier name', async () => {
      mockFsReadFile.mockResolvedValue(`
tiers:
  huge:
    provider: claude
    model: opus
`);

      await expect(
        updateGlobalConfig({ tiers: { small: { provider: 'claude', model: 'haiku' } } })
      ).rejects.toThrow(/Invalid model binding config.*tiers\.huge/);
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('refuses an unrelated edit that leaves an invalid workflows block in place', async () => {
      mockFsReadFile.mockResolvedValue(`
botName: MyBot
workflows:
  quotaMaxAttempts: many
`);

      await expect(updateGlobalConfig({ defaultAssistant: 'claude' })).rejects.toThrow(
        /Invalid workflows config.*quotaMaxAttempts/
      );
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('a patch that repairs the invalid workflows block keeps every unrelated key', async () => {
      mockFsReadFile.mockResolvedValue(`
botName: MyBot
workflows:
  quotaMaxAttempts: many
`);

      await updateGlobalConfig({ workflows: { quotaMaxAttempts: 3 } });

      const written = Bun.YAML.parse(mockFsWriteFile.mock.calls[0]?.[1] as string);
      expect(written).toEqual({ botName: 'MyBot', workflows: { quotaMaxAttempts: 3 } });
    });

    test('an edit to one provider does not overwrite a malformed entry for another', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  codex: high
`);

      await expect(
        updateGlobalConfig({ assistants: { claude: { model: 'opus' } } })
      ).rejects.toThrow(/assistants\.codex' must be an object/);
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    // The settings API returns 400 for this class and 500 for anything else, and
    // shows `summary` to the web client, so it must not carry the server's path.
    test('a refused edit is an InvalidConfigError whose summary names the key, not the path', async () => {
      mockFsReadFile.mockResolvedValue(fileWithBadTier);

      const error = await updateGlobalConfig({ defaultAssistant: 'claude' }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(InvalidConfigError);
      const { summary } = error as InvalidConfigError;
      expect(summary).toMatch(/^Invalid model binding config: tiers\.large\.model/);
      expect(summary).not.toContain('config.yaml');
    });

    test('never overwrites a file that is not valid YAML', async () => {
      mockFsReadFile.mockResolvedValue('botName: MyBot\ntiers: [unclosed\n');

      await expect(updateGlobalConfig({ defaultAssistant: 'claude' })).rejects.toThrow(
        /config\.yaml/
      );
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('never overwrites a file whose top level is not a map', async () => {
      mockFsReadFile.mockResolvedValue('- botName: MyBot\n');

      await expect(updateGlobalConfig({ defaultAssistant: 'claude' })).rejects.toThrow(
        /not a map of settings/
      );
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    test('never overwrites a file that cannot be read', async () => {
      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockFsReadFile.mockRejectedValue(permError);

      await expect(updateGlobalConfig({ defaultAssistant: 'claude' })).rejects.toThrow(
        'Permission denied'
      );
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('toSafeConfig', () => {
    test('strips paths from MergedConfig', async () => {
      mockFsReadFile.mockResolvedValue('');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe).not.toHaveProperty('paths');
    });

    test('strips entire commands object from MergedConfig', async () => {
      mockFsReadFile.mockResolvedValue('');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe).not.toHaveProperty('commands');
    });

    test('strips additionalDirectories from assistants.codex', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  codex:
    additionalDirectories:
      - /sensitive/path
`);
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe.assistants.codex).not.toHaveProperty('additionalDirectories');
    });

    test('preserves non-sensitive fields', async () => {
      mockFsReadFile.mockResolvedValue('defaultAssistant: codex');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(typeof safe.botName).toBe('string');
      expect(safe.assistant).toBe('codex');
      expect(safe.streaming).toBeDefined();
      expect(safe.concurrency).toBeDefined();
      expect(safe.defaults).toBeDefined();
      expect(safe.assistants).toBeDefined();
      expect(safe.assistants.claude).toBeDefined();
      expect(safe.assistants.codex).toBeDefined();
      expect(safe.assistants.codex).not.toHaveProperty('additionalDirectories');
    });

    test('exposes configured tiers and computed tierDefaults', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: claude
tiers:
  large:
    provider: codex
    model: gpt-5.5
`);
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      // Configured tier round-trips.
      expect(safe.tiers?.large).toEqual({ provider: 'codex', model: 'gpt-5.5' });
      // tierDefaults = built-in presets for the default provider (claude → opus@large).
      expect(safe.tierDefaults?.large).toEqual({ provider: 'claude', model: 'opus' });
      expect(safe.tierDefaults?.small).toEqual({ provider: 'claude', model: 'haiku' });
    });
  });
});
