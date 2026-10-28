// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { loadGlobalConfig, loadRepoConfig, updateGlobalConfig } from './config-loader';
import { archonHome, mockFsReadFile, mockFsWriteFile, useConfigTestEnv } from './test-harness';

describe('config validation', () => {
  useConfigTestEnv();

  describe('assistants validation', () => {
    test('global config refuses to load an effort the provider would drop', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  codex:
    modelReasoningEffort: extreme
`);

      await expect(loadGlobalConfig()).rejects.toThrow(
        /assistants\.codex\.modelReasoningEffort.*minimal, low, medium, high, xhigh, max/
      );
      await expect(loadGlobalConfig()).rejects.toThrow(join(archonHome, 'config.yaml'));
    });

    test('repo config refuses to load an unknown provider setting', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  claude:
    modle: sonnet
`);

      await expect(loadRepoConfig('/test/repo')).rejects.toThrow(
        /assistants\.claude\.modle.*unknown provider setting/
      );
    });

    test('repo config refuses a settingSources entry Claude does not honour', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  claude:
    settingSources:
      - projekt
`);

      await expect(loadRepoConfig('/test/repo')).rejects.toThrow(
        /assistants\.claude\.settingSources\.0.*'project' or 'user'/
      );
    });

    test('keeps process-scoped Pi defaults loadable from config.yaml', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  pi:
    env:
      PLANNOTATOR_REMOTE: '1'
    maxConcurrent: 4
`);

      const config = await loadGlobalConfig();
      expect(config.assistants?.pi).toEqual({
        env: { PLANNOTATOR_REMOTE: '1' },
        maxConcurrent: 4,
      });
    });

    // Archon owns the embedded OpenCode runtime, so a server URL has no consumer.
    test('rejects an OpenCode server URL as an unknown setting', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  opencode:
    model: anthropic/claude-3-5-sonnet
    baseUrl: http://localhost:4096
`);

      await expect(loadGlobalConfig()).rejects.toThrow(
        /assistants\.opencode\.baseUrl.*unknown provider setting/
      );
    });

    test.each([
      ['an empty assistants block', 'assistants:\n'],
      ['an empty provider block', 'assistants:\n  codex:\n'],
    ])('loads a config with %s', async (_label, yaml) => {
      mockFsReadFile.mockResolvedValue(yaml);

      await expect(loadGlobalConfig()).resolves.toBeDefined();
    });

    test('keeps an unregistered provider entry passing through unvalidated', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  nonesuch:
    modelReasoningEffort: extreme
`);

      const config = await loadGlobalConfig();
      expect(config.assistants?.nonesuch).toEqual({ modelReasoningEffort: 'extreme' });
    });

    // The settings API validates its body as `record(string, unknown)`, so any
    // key and value can reach updateGlobalConfig at runtime even though the
    // typed provider defaults would reject a misspelled effort value.
    test('refuses to persist assistant defaults the loaders would then reject', async () => {
      mockFsReadFile.mockResolvedValue('');

      const misspelled: Record<string, unknown> = { modelReasoningEfort: 'high' };
      await expect(updateGlobalConfig({ assistants: { codex: misspelled } })).rejects.toThrow(
        /assistants\.codex\.modelReasoningEfort.*unknown provider setting/
      );
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });

    // Settings API and `archon ai tier/alias set` all write through
    // updateGlobalConfig, so validating the file on read would lock the
    // operator out of repairing it through Archon.
    test('repairs an invalid assistant default already in the file', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  codex:
    modelReasoningEffort: extreme
`);

      await updateGlobalConfig({ assistants: { codex: { modelReasoningEffort: 'high' } } });

      expect(mockFsWriteFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFsWriteFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('high');
      expect(writtenContent).not.toContain('extreme');
    });

    test('refuses an unrelated edit that leaves an invalid assistant default in place', async () => {
      mockFsReadFile.mockResolvedValue(`
assistants:
  codex:
    modelReasoningEffort: extreme
`);

      await expect(
        updateGlobalConfig({ tiers: { large: { provider: 'claude', model: 'opus' } } })
      ).rejects.toThrow(/assistants\.codex\.modelReasoningEffort/);
      expect(mockFsWriteFile).not.toHaveBeenCalled();
    });
  });
});
