/**
 * Tests for setup command utility functions
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { bootstrapProjectConfig, setupCommand } from './setup';
import { collectAIConfig } from './setup-ai';
import * as setupAi from './setup-ai';
import * as providerAuth from './setup-provider-auth';
import * as doctorModule from './doctor';
import * as prompts from '@clack/prompts';
import { removeTempTree } from '@archon/paths/test-utils';

// Test directory for file operations
const TEST_DIR = join(tmpdir(), 'archon-setup-test-' + Date.now());

describe('setup command', () => {
  beforeEach(() => {
    // Create test directory
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await removeTempTree(TEST_DIR);
  });

  describe('bootstrapProjectConfig', () => {
    it('creates .archon/config.yaml when it does not exist', () => {
      const target = join(TEST_DIR, 'bootstrap-target');
      mkdirSync(target, { recursive: true });

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('created');
      expect(result.path).toBe(join(target, '.archon', 'config.yaml'));
      expect(existsSync(result.path)).toBe(true);
      const content = readFileSync(result.path, 'utf-8');
      // Must be valid YAML — comment lines only — so loaders treat it as empty.
      expect(content.split('\n').every(line => line === '' || line.startsWith('#'))).toBe(true);
      expect(content).toContain('Project-scoped Archon config');
      expect(content).toContain('archon.diy/reference/configuration');
    });

    it('creates the .archon directory if missing (idempotent on parent)', () => {
      const target = join(TEST_DIR, 'bootstrap-no-archon-dir');
      mkdirSync(target, { recursive: true });
      // Do NOT pre-create .archon — bootstrap must create it

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('created');
      expect(existsSync(join(target, '.archon'))).toBe(true);
    });

    it('is idempotent — leaves an existing config untouched', () => {
      const target = join(TEST_DIR, 'bootstrap-existing');
      const archonDir = join(target, '.archon');
      mkdirSync(archonDir, { recursive: true });
      const userContent = '# my custom config\nassistants:\n  claude:\n    model: opus\n';
      writeFileSync(join(archonDir, 'config.yaml'), userContent);

      const result = bootstrapProjectConfig(target);

      expect(result.state).toBe('existed');
      const after = readFileSync(join(archonDir, 'config.yaml'), 'utf-8');
      expect(after).toBe(userContent);
    });

    it('returns failed state without throwing when the target path is unwritable', () => {
      // Pointing at a path inside a non-existent parent that mkdirSync can
      // create succeeds. Use a deeply-nested path inside a regular file
      // (which fs cannot mkdir into) to force a real failure.
      const blocker = join(TEST_DIR, 'blocker-file');
      writeFileSync(blocker, 'not a directory');
      // mkdir under a file path fails with ENOTDIR — that's the failure mode
      // we want to model (read-only FS, permission denied, etc.).
      const result = bootstrapProjectConfig(blocker);

      expect(result.state).toBe('failed');
      if (result.state === 'failed') {
        expect(result.error.length).toBeGreaterThan(0);
      }
    });
  });
});
describe('setup provider selection', () => {
  it.each(['fresh', 'add'] as const)(
    '%s setup uses diagnostics and persists the selected default for multiple providers',
    async mode => {
      const root = mkdtempSync(join(tmpdir(), 'archon-setup-providers-'));
      const savedEnv = { ...process.env };
      delete process.env.DEFAULT_AI_ASSISTANT;
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      process.env.ARCHON_HOME = join(root, 'archon');
      if (mode === 'add') {
        mkdirSync(join(root, 'archon'));
        writeFileSync(join(root, 'archon', '.env'), 'SLACK_BOT_TOKEN=preserved\n');
      }
      const selection = spyOn(prompts, 'select').mockImplementation(async options => {
        const wanted =
          options.message === 'What would you like to do?'
            ? 'add'
            : options.message.startsWith('How do you want')
              ? 'global'
              : options.message.startsWith('Which should')
                ? 'codex'
                : '__keep__';
        const chosen = options.options.find(option => option.value === wanted);
        if (!chosen) throw new Error(`Unexpected prompt: ${options.message}`);
        return chosen.value;
      });
      const input = spyOn(prompts, 'text').mockResolvedValue('');
      const confirm = spyOn(prompts, 'confirm').mockImplementation(
        async options => options.message === 'Run `archon doctor` now to verify your setup?'
      );
      const detect = spyOn(providerAuth, 'detectClaudeExecutablePath').mockReturnValue(null);
      const info = spyOn(prompts.log, 'info').mockImplementation(() => undefined);
      const install = mock(async (_ids: readonly string[]) => undefined);
      const diagnose = mock(async (id: string) => [
        { label: id, status: 'pass' as const, message: 'provider-owned check' },
      ]);
      const originalCollect = collectAIConfig;
      const collect = spyOn(setupAi, 'collectAIConfig').mockImplementation(options =>
        originalCollect(options, install, diagnose)
      );
      const platforms = spyOn(prompts, 'multiselect').mockResolvedValue([]);
      const doctor = spyOn(doctorModule, 'doctorCommand').mockResolvedValue(0);
      try {
        expect(await setupCommand({ repoPath: root, providers: ['claude', 'codex'] })).toBe(0);
        expect(detect).toHaveBeenCalled();
        expect(doctor).toHaveBeenCalledWith();
        expect(process.env).toMatchObject({ DEFAULT_AI_ASSISTANT: 'codex' });
        expect(install).toHaveBeenCalledWith(['claude', 'codex']);
        expect(diagnose.mock.calls).toEqual([['claude'], ['codex']]);
        expect(info.mock.calls.flat().join('')).toContain('provider-owned check');
        const written = Bun.YAML.parse(readFileSync(join(root, 'archon', 'config.yaml'), 'utf8'));
        expect(written).toMatchObject({ defaultAssistant: 'codex' });
        if (mode === 'add') {
          expect(readFileSync(join(root, 'archon', '.env'), 'utf8')).toContain(
            'SLACK_BOT_TOKEN=preserved'
          );
        }
      } finally {
        for (const spy of [selection, input, confirm, detect, info, collect, platforms, doctor])
          spy.mockRestore();
        // Restore in place: replacing process.env leaves Bun's native env holding the
        // temp root, which os.homedir() still reads through USERPROFILE on Windows.
        for (const key of Object.keys(process.env)) {
          if (!(key in savedEnv)) delete process.env[key];
        }
        Object.assign(process.env, savedEnv);
        await removeTempTree(root);
      }
    }
  );
});
