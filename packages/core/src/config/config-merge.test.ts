// @archon-test-isolated
import { clearRegistry, getRegisteredProviders, registerProvider } from '@archon/providers';
import { describe, test, expect } from 'bun:test';
import { loadConfig, clearConfigCache, toSafeConfig } from './config-loader';
import { mockFsReadFile, useConfigTestEnv } from './test-harness';

describe('config layer merge', () => {
  useConfigTestEnv();

  describe('loadConfig', () => {
    test('tolerates retired YAML keys without merging or exposing them', async () => {
      mockFsReadFile
        .mockResolvedValueOnce(`
paths:
  workspaces: /unused/workspaces
  worktrees: /unused/worktrees
concurrency:
  maxConversations: 7
`)
        .mockResolvedValueOnce(`
defaults:
  copyDefaults: false
  loadDefaultCommands: false
`);
      const config = await loadConfig('/test/repo');
      expect(config.concurrency.maxConversations).toBe(7);
      expect(config.defaults.loadDefaultCommands).toBe(false);
      expect(config).not.toHaveProperty('paths');
      expect(config.defaults).not.toHaveProperty('copyDefaults');
      expect(toSafeConfig(config).defaults).not.toHaveProperty('copyDefaults');
    });

    test('returns defaults when no configs exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.assistant).toBeUndefined();
      // Built-ins always present; community providers (like `pi`) are
      // seeded dynamically from the registry — check the built-ins
      // explicitly rather than asserting an exhaustive shape.
      expect(config.assistants.claude).toEqual({});
      expect(config.assistants.codex).toEqual({});
      expect(config.streaming.streamtest).toBe('stream');
      expect(config.concurrency.maxConversations).toBe(10);
      expect(config.workflows).toEqual({
        toolCallAttentionMs: 1800000,
        autoResumeOnQuotaReset: true,
      });
    });

    test('merges global and repo workflow policy per field, without deprecated quota keys', async () => {
      mockFsReadFile
        .mockResolvedValueOnce(`
workflows:
  toolCallAttentionMs: 60000
  autoResumeOnQuotaReset: true
  quotaFallbackDelayMs: 3600000
  quotaMaxAttempts: 2
`)
        .mockResolvedValueOnce(`
workflows:
  toolCallAttentionMs: 0
  quotaMaxAttempts: 3
  quotaDeadlineMs: 43200000
`);

      const config = await loadConfig('/test/repo');

      expect(config.workflows).toEqual({
        toolCallAttentionMs: 0,
        autoResumeOnQuotaReset: true,
      });
    });

    test('only one installed provider is the default; zero or multiple leave it unset', async () => {
      const providers = getRegisteredProviders();
      try {
        clearRegistry();
        clearConfigCache();
        expect((await loadConfig()).assistant).toBeUndefined();
        const codex = providers.find(provider => provider.id === 'codex');
        if (!codex) throw new Error('missing fixture');
        registerProvider(codex);
        clearConfigCache();
        expect((await loadConfig()).assistant).toBe('codex');
        const pi = providers.find(provider => provider.id === 'pi');
        if (!pi) throw new Error('missing fixture');
        registerProvider(pi);
        clearConfigCache();
        expect((await loadConfig()).assistant).toBeUndefined();
      } finally {
        clearRegistry();
        for (const provider of providers) registerProvider(provider);
        clearConfigCache();
      }
    });

    test('env var DEFAULT_AI_ASSISTANT is a fallback — config file assistant wins', async () => {
      mockFsReadFile.mockResolvedValue(`
defaultAssistant: claude
streaming:
  streamtest: stream
`);

      process.env.DEFAULT_AI_ASSISTANT = 'codex';
      process.env.STREAMTEST_STREAMING_MODE = 'batch';

      const config = await loadConfig();

      // Config file explicitly set 'claude' — env var must NOT override it
      expect(config.assistant).toBe('claude');
      // Streaming env var still overrides (no config-file guard needed there)
      expect(config.streaming.streamtest).toBe('batch');
    });

    test('env var DEFAULT_AI_ASSISTANT applies when no config file sets the assistant', async () => {
      // Global config exists but does not set defaultAssistant
      mockFsReadFile.mockResolvedValue('streaming:\n  streamtest: stream\n');
      process.env.DEFAULT_AI_ASSISTANT = 'codex';

      const config = await loadConfig();

      expect(config.assistant).toBe('codex');
    });

    test('env var DEFAULT_AI_ASSISTANT does not override repo config assistant', async () => {
      const pathMatches = (path: string, pattern: string): boolean =>
        path.replace(/\\/g, '/').includes(pattern);

      let globalRead = false;
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return 'assistant: claude';
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalRead) {
          globalRead = true;
          return ''; // global config has no assistant
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      process.env.DEFAULT_AI_ASSISTANT = 'codex';

      const config = await loadConfig('/test/repo');
      expect(config.assistant).toBe('claude');
    });

    test('throws on unknown DEFAULT_AI_ASSISTANT env var', async () => {
      mockFsReadFile.mockResolvedValue('');
      process.env.DEFAULT_AI_ASSISTANT = 'nonexistent-provider';

      await expect(loadConfig()).rejects.toThrow(/Unknown provider:/);
    });

    test('invalid DEFAULT_AI_ASSISTANT env var is silently ignored when config file sets assistant', async () => {
      mockFsReadFile.mockResolvedValue('defaultAssistant: claude\n');
      process.env.DEFAULT_AI_ASSISTANT = 'nonexistent-provider';

      // Must not throw — config file takes precedence and the invalid env var is skipped
      const config = await loadConfig();
      expect(config.assistant).toBe('claude');
    });

    test('throws on unknown defaultAssistant in global config', async () => {
      mockFsReadFile.mockResolvedValue('defaultAssistant: nonexistent-provider');

      await expect(loadConfig()).rejects.toThrow(/Unknown provider:/);
    });

    test('throws on unknown assistant in repo config', async () => {
      mockFsReadFile.mockImplementation(async (path: string) => {
        const normalized = path.replace(/\\/g, '/');
        if (normalized.includes('/tmp/test-repo/.archon/config.yaml')) {
          return 'assistant: nonexistent-provider';
        }
        return '';
      });

      await expect(loadConfig('/tmp/test-repo')).rejects.toThrow(/Unknown provider:/);
    });

    test('repo config overrides global config', async () => {
      // Helper to check path in cross-platform way (handles both / and \ separators)
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockFsReadFile.mockImplementation(async (path: string) => {
        // First check for repo-specific config path (contains /repo/.archon/)
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return 'assistant: codex';
        }
        // Then check for global config (just .archon/config.yaml but not under /repo/)
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return 'defaultAssistant: claude';
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistant).toBe('codex');
    });

    test('merges assistant defaults from global and repo config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `assistants:\n  codex:\n    webSearchMode: live\n    additionalDirectories:\n      - /repo\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return `assistants:\n  claude:\n    model: sonnet\n  codex:\n    model: gpt-5.6-sol\n    modelReasoningEffort: medium\n`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistants.claude.model).toBe('sonnet');
      expect(config.assistants.codex.model).toBe('gpt-5.6-sol');
      expect(config.assistants.codex.modelReasoningEffort).toBe('medium');
      expect(config.assistants.codex.webSearchMode).toBe('live');
      expect(config.assistants.codex.additionalDirectories).toEqual(['/repo']);
    });

    test('propagates baseBranch from repo worktree config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  baseBranch: develop
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBe('develop');
    });

    test('trims whitespace from baseBranch', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  baseBranch: "  staging  "
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBe('staging');
    });

    test('baseBranch is undefined when not configured', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBeUndefined();
    });

    test('propagates remote from repo worktree config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  remote: upstream
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.remote).toBe('upstream');
    });

    test('trims whitespace from remote', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  remote: "  mar  "
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.remote).toBe('mar');
    });

    test('remote is undefined when not configured', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.remote).toBeUndefined();
    });

    test('global aliases are propagated to merged config', async () => {
      mockFsReadFile.mockResolvedValue(`
aliases:
  '@fast': { provider: claude, model: haiku }
`);

      const config = await loadConfig();
      expect(config.aliases).toEqual({
        '@fast': { provider: 'claude', model: 'haiku' },
      });
    });

    test('repo aliases override global aliases with same key', async () => {
      const pathMatches = (path: string, pattern: string): boolean =>
        path.replace(/\\/g, '/').includes(pattern);

      let globalRead = false;
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `aliases:\n  '@fast': { provider: codex, model: gpt-5-mini }\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalRead) {
          globalRead = true;
          return `aliases:\n  '@fast': { provider: claude, model: haiku }\n  '@deep': { provider: claude, model: opus }\n`;
        }
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      });

      const config = await loadConfig('/test/repo');
      expect(config.aliases?.['@fast']).toEqual({ provider: 'codex', model: 'gpt-5-mini' });
      expect(config.aliases?.['@deep']).toEqual({ provider: 'claude', model: 'opus' });
    });

    test('config.aliases is undefined when no aliases configured', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig();
      expect(config.aliases).toBeUndefined();
    });

    test('global tiers are propagated to merged config', async () => {
      mockFsReadFile.mockResolvedValue(`
tiers:
  large: { provider: claude, model: opus }
  medium: { provider: codex, model: gpt-5.5, effort: high }
`);

      const config = await loadConfig();
      expect(config.tiers).toEqual({
        large: { provider: 'claude', model: 'opus' },
        medium: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
      });
    });

    test('repo tiers override global tiers with same key', async () => {
      const pathMatches = (path: string, pattern: string): boolean =>
        path.replace(/\\/g, '/').includes(pattern);

      let globalRead = false;
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `tiers:\n  medium: { provider: codex, model: gpt-5.5, effort: medium }\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalRead) {
          globalRead = true;
          return `tiers:\n  small: { provider: claude, model: haiku }\n  medium: { provider: claude, model: sonnet }\n`;
        }
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      });

      const config = await loadConfig('/test/repo');
      expect(config.tiers?.medium).toEqual({
        provider: 'codex',
        model: 'gpt-5.5',
        effort: 'medium',
      });
      expect(config.tiers?.small).toEqual({ provider: 'claude', model: 'haiku' });
    });

    test('config.tiers is undefined when no tiers configured', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig();
      expect(config.tiers).toBeUndefined();
    });

    test('propagates docsPath from repo docs config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
docs:
  path: packages/docs-web/src/content/docs
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.docsPath).toBe('packages/docs-web/src/content/docs');
    });

    test('trims whitespace from docsPath', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
docs:
  path: "  custom/docs/  "
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.docsPath).toBe('custom/docs/');
    });

    test('docsPath is undefined when docs config is absent', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.docsPath).toBeUndefined();
    });

    test('propagates env vars from repo config', async () => {
      const pathMatches = (path: string, pattern: string): boolean =>
        path.replace(/\\/g, '/').includes(pattern);

      mockFsReadFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
env:
  MY_TOKEN: abc123
  API_BASE: https://api.example.com
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.envVars).toEqual({ MY_TOKEN: 'abc123', API_BASE: 'https://api.example.com' });
    });

    test('envVars is undefined when repo config has no env section', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFsReadFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.envVars).toBeUndefined();
    });
  });
});
