/**
 * Tests for the user-global command fallback in loadCommandPrompt.
 *
 * Isolated in its own test file (and its own bun test invocation — see package.json)
 * because it mocks @archon/paths differently than executor-shared.test.ts:
 * this file needs getArchonHome + getCommandFolderSearchPaths to be present,
 * whereas the other file only cares about createLogger. Two files cannot
 * mock.module() the same path with different implementations in one batch.
 */
import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger + paths BEFORE importing module under test
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

// Hand-rolled partial mock of @archon/paths. Provides getArchonHome via the
// test's ARCHON_HOME env and getCommandFolderSearchPaths as a static list,
// mirroring the real implementations.
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: (): string => {
    const envHome = process.env.ARCHON_HOME;
    if (!envHome) throw new Error('ARCHON_HOME not set in test');
    return envHome;
  },
  getCommandFolderSearchPaths: (configured?: string): string[] => {
    const paths = ['.archon/commands', '.archon/commands/defaults'];
    if (configured && !paths.includes(configured)) paths.push(configured);
    return paths;
  },
  // No-op defaults path so the app-defaults branch never hits the real filesystem
  getDefaultCommandsPath: (): string => '/dev/null/nonexistent',
}));

// Mock bundled-defaults to avoid loading the real binary build check
mock.module('./defaults/bundled-defaults', () => ({
  BUNDLED_COMMANDS: {},
  isBinaryBuild: (): boolean => false,
}));

import { loadCommandPrompt } from './executor-shared';
import type { WorkflowDeps } from './deps';

// Minimal deps — loadCommandPrompt only uses deps.loadConfig
const makeDeps = (loadDefaultCommands = true): WorkflowDeps =>
  ({
    loadConfig: async () => ({ defaults: { loadDefaultCommands } }),
  }) as unknown as WorkflowDeps;

describe('loadCommandPrompt — user-global fallback', () => {
  let repoCwd: string;
  let globalHome: string;

  beforeAll(async () => {
    repoCwd = await mkdtemp(join(tmpdir(), 'archon-test-repo-'));
    globalHome = await mkdtemp(join(tmpdir(), 'archon-test-home-'));
    process.env.ARCHON_HOME = globalHome;
  });

  afterAll(async () => {
    await rm(repoCwd, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    delete process.env.ARCHON_HOME;
  });

  beforeEach(async () => {
    // Wipe contents between tests but keep the tmpdirs themselves
    await rm(join(repoCwd, '.archon'), { recursive: true, force: true });
    await rm(join(globalHome, '.archon'), { recursive: true, force: true });
  });

  it('loads a command only present in the user-global dir', async () => {
    await mkdir(join(globalHome, '.archon', 'commands'), { recursive: true });
    await writeFile(
      join(globalHome, '.archon', 'commands', 'greet-global.md'),
      'You are a greeter. Say hello!'
    );

    const result = await loadCommandPrompt(makeDeps(), repoCwd, 'greet-global');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe('You are a greeter. Say hello!');
    }
  });

  it('prefers the repo-local copy over the global copy when both exist', async () => {
    await mkdir(join(repoCwd, '.archon', 'commands'), { recursive: true });
    await mkdir(join(globalHome, '.archon', 'commands'), { recursive: true });
    await writeFile(join(repoCwd, '.archon', 'commands', 'shared.md'), 'repo version');
    await writeFile(join(globalHome, '.archon', 'commands', 'shared.md'), 'global version');

    const result = await loadCommandPrompt(makeDeps(), repoCwd, 'shared');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe('repo version');
    }
  });

  it('returns empty_file when the global command file is empty', async () => {
    await mkdir(join(globalHome, '.archon', 'commands'), { recursive: true });
    await writeFile(join(globalHome, '.archon', 'commands', 'blank.md'), '   \n\n');

    const result = await loadCommandPrompt(makeDeps(), repoCwd, 'blank');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('empty_file');
      expect(result.message).toContain('global');
    }
  });

  it('fails with not_found when absent in repo, global, and defaults', async () => {
    const result = await loadCommandPrompt(makeDeps(), repoCwd, 'ghost-command');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('not_found');
      // Message should mention both repo-relative and global paths
      expect(result.message).toContain('.archon/commands');
      expect(result.message).toContain(globalHome);
    }
  });
});
