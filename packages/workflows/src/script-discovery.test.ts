import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock fs/promises before importing the module under test
const mockReaddir = mock(async (_path: string): Promise<string[]> => []);
const mockStat = mock(async (_path: string) => ({ isDirectory: () => false }));

mock.module('fs/promises', () => ({
  access: mock(async () => undefined),
  mkdir: mock(async () => undefined),
  readdir: mockReaddir,
  rename: mock(async () => undefined),
  rm: mock(async () => undefined),
  stat: mockStat,
  writeFile: mock(async () => undefined),
}));

// Mock logger
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
let mockHomeScriptsPath = '/home/scripts';
let mockHomeWorkflowsPath = '/home/workflows';
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => '/home'),
  getDefaultWorkflowsPath: mock(() => '/app/workflows/defaults'),
  getHomeScriptsPath: mock(() => mockHomeScriptsPath),
  getHomeWorkflowsPath: mock(() => mockHomeWorkflowsPath),
}));

import { discoverScripts, discoverScriptsForCwd, getDefaultScripts } from './script-discovery';
import { formatPackagedResourceReference } from './packaged-workflow';

// On Windows, path.join produces backslashes (e.g. `\scripts\triage`). The
// mocks below key on forward-slash paths for readability, so normalize before
// comparing. Production paths are stored via normalizeSep(), so assertions on
// stored paths remain forward-slash on every OS.
const norm = (p: string): string => p.replaceAll('\\', '/');

describe('discoverScripts', () => {
  beforeEach(() => {
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
  });

  test('returns empty map when directory does not exist', async () => {
    mockReaddir.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    );
    const result = await discoverScripts('/some/nonexistent/dir');
    expect(result.size).toBe(0);
  });

  test('returns empty map when directory is empty', async () => {
    mockReaddir.mockResolvedValueOnce([]);
    const result = await discoverScripts('/scripts');
    expect(result.size).toBe(0);
  });

  test('discovers a TypeScript file as bun runtime', async () => {
    mockReaddir.mockResolvedValueOnce(['fetch-prices.ts']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.size).toBe(1);
    const script = result.get('fetch-prices');
    expect(script).toBeDefined();
    expect(script!.name).toBe('fetch-prices');
    expect(script!.runtime).toBe('bun');
    expect(script!.path).toBe('/scripts/fetch-prices.ts');
  });

  test('discovers a JavaScript file as bun runtime', async () => {
    mockReaddir.mockResolvedValueOnce(['compute.js']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    const script = result.get('compute');
    expect(script).toBeDefined();
    expect(script!.runtime).toBe('bun');
  });

  test('discovers a Python file as uv runtime', async () => {
    mockReaddir.mockResolvedValueOnce(['analyze.py']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    const script = result.get('analyze');
    expect(script).toBeDefined();
    expect(script!.runtime).toBe('uv');
    expect(script!.path).toBe('/scripts/analyze.py');
  });

  test('skips files with unknown extensions', async () => {
    mockReaddir.mockResolvedValueOnce(['script.rb', 'notes.txt', 'run.sh']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.size).toBe(0);
  });

  test('keys scripts by filename without extension', async () => {
    mockReaddir.mockResolvedValueOnce(['my-cool-script.ts']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.has('my-cool-script')).toBe(true);
    expect(result.has('my-cool-script.ts')).toBe(false);
  });

  test('throws on duplicate script names across extensions', async () => {
    mockReaddir.mockResolvedValueOnce(['fetch.ts', 'fetch.py']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    await expect(discoverScripts('/scripts')).rejects.toThrow(/Duplicate script name "fetch"/);
  });

  test('includes both paths in duplicate error message', async () => {
    mockReaddir.mockResolvedValueOnce(['run.js', 'run.py']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    try {
      await discoverScripts('/scripts');
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('run.js');
      expect(message).toContain('run.py');
      expect(message).toContain('unique across extensions');
    }
  });

  test('recursively scans subdirectories', async () => {
    // Top-level readdir returns one directory and one file
    mockReaddir.mockResolvedValueOnce(['subdir', 'top.ts']);
    // stat for 'subdir' - is a directory
    mockStat.mockResolvedValueOnce({ isDirectory: () => true });
    // readdir for subdir
    mockReaddir.mockResolvedValueOnce(['nested.py']);
    // stat for nested.py
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    // stat for top.ts
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/scripts');

    expect(result.size).toBe(2);
    expect(result.has('nested')).toBe(true);
    expect(result.get('nested')!.runtime).toBe('uv');
    expect(result.has('top')).toBe(true);
    expect(result.get('top')!.runtime).toBe('bun');
  });

  test('stores the full path in the script definition', async () => {
    mockReaddir.mockResolvedValueOnce(['prices.ts']);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });

    const result = await discoverScripts('/my/scripts');

    const script = result.get('prices');
    expect(script!.path).toBe('/my/scripts/prices.ts');
  });
});

describe('scanScriptDir depth cap', () => {
  // Scripts are discovered 1 level deep (matches the workflows/commands
  // convention). `defaults/` style subfolders are fine; nested subfolders are not.
  beforeEach(() => {
    mockReaddir.mockReset();
    mockStat.mockReset();
  });

  test('allows files in a 1-level subfolder', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/scripts') return ['triage', 'top.ts'];
      if (p === '/scripts/triage') return ['helper.py'];
      return [];
    });
    mockStat.mockImplementation(async (path: string) => ({
      isDirectory: () => norm(path) === '/scripts/triage',
    }));

    const result = await discoverScripts('/scripts');
    expect(result.has('top')).toBe(true);
    expect(result.has('helper')).toBe(true);
  });

  test('does NOT descend into nested subfolders (cap at depth 1)', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/scripts') return ['level-one'];
      if (p === '/scripts/level-one') return ['level-two'];
      if (p === '/scripts/level-one/level-two') return ['too-deep.ts'];
      return [];
    });
    mockStat.mockImplementation(async (path: string) => {
      const p = norm(path);
      return {
        isDirectory: () => p === '/scripts/level-one' || p === '/scripts/level-one/level-two',
      };
    });

    const result = await discoverScripts('/scripts');
    expect(result.has('too-deep')).toBe(false);
    expect(result.size).toBe(0);
  });
});

describe('discoverScriptsForCwd — merge repo + home with repo winning', () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    mockStat.mockReset();
    mockHomeScriptsPath = '/home/scripts';
    mockHomeWorkflowsPath = '/home/workflows';
  });

  test('merges scripts from ~/.archon/scripts and <cwd>/.archon/scripts', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/home/scripts') return ['home-only.ts'];
      if (p === '/repo/.archon/scripts') return ['repo-only.py'];
      return [];
    });
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await discoverScriptsForCwd('/repo');
    expect(result.has('home-only')).toBe(true);
    expect(result.has('repo-only')).toBe(true);
    expect(result.size).toBe(2);
  });

  test('repo-scoped script overrides same-named home script', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/home/scripts') return ['shared.ts'];
      if (p === '/repo/.archon/scripts') return ['shared.ts'];
      return [];
    });
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await discoverScriptsForCwd('/repo');
    expect(result.size).toBe(1);
    // Stored paths are normalized to forward slashes via normalizeSep() in
    // script-discovery.ts, so this assertion is OS-independent.
    expect(result.get('shared')!.path).toBe('/repo/.archon/scripts/shared.ts');
  });

  test('tolerates missing home dir (new user, no personal scripts yet)', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/home/scripts') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      if (p === '/repo/.archon/scripts') return ['only-repo.ts'];
      return [];
    });
    mockStat.mockResolvedValue({ isDirectory: () => false });

    const result = await discoverScriptsForCwd('/repo');
    expect(result.size).toBe(1);
    expect(result.has('only-repo')).toBe(true);
  });

  test('tolerates an ENOENT race while scanning a packaged workflow', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/app/workflows') return ['removed-pack'];
      return [];
    });
    mockStat.mockRejectedValueOnce(Object.assign(new Error('removed'), { code: 'ENOENT' }));

    await expect(discoverScriptsForCwd('/repo')).resolves.toEqual(new Map());
  });

  test('surfaces permission failures while scanning packaged workflows', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/app/workflows') return ['private-pack'];
      return [];
    });
    mockStat.mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    );

    await expect(discoverScriptsForCwd('/repo')).rejects.toThrow(
      'Failed to inspect packaged workflow pack'
    );
  });

  test('isolates identical local script names in repo and home packaged workflows', async () => {
    mockReaddir.mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p === '/app/workflows') return [];
      if (p === '/home/scripts' || p === '/repo/.archon/scripts') return [];
      if (p === '/home/workflows') return ['personal-pack'];
      if (p === '/home/workflows/personal-pack') return ['daily'];
      if (p === '/home/workflows/personal-pack/daily/scripts') return ['shared.py'];
      if (p === '/repo/.archon/workflows') return ['team-pack'];
      if (p === '/repo/.archon/workflows/team-pack') return ['release'];
      if (p === '/repo/.archon/workflows/team-pack/release/scripts') return ['shared.ts'];
      return [];
    });
    mockStat.mockImplementation(async (path: string) => ({
      isDirectory: () => !/\.(ts|py)$/.test(norm(path)),
    }));

    const result = await discoverScriptsForCwd('/repo');
    const homeName = formatPackagedResourceReference(
      { source: 'global', pack: 'personal-pack', workflow: 'daily' },
      'shared'
    );
    const repoName = formatPackagedResourceReference(
      { source: 'project', pack: 'team-pack', workflow: 'release' },
      'shared'
    );
    expect(result.get(homeName)?.runtime).toBe('uv');
    expect(result.get(repoName)?.runtime).toBe('bun');
    expect(result.get(homeName)?.path).toBe(
      '/home/workflows/personal-pack/daily/scripts/shared.py'
    );
    expect(result.get(repoName)?.path).toBe(
      '/repo/.archon/workflows/team-pack/release/scripts/shared.ts'
    );
  });
});

describe('getDefaultScripts', () => {
  test('returns an empty Map', () => {
    const defaults = getDefaultScripts();
    expect(defaults).toBeInstanceOf(Map);
    expect(defaults.size).toBe(0);
  });

  test('returns a new Map each call', () => {
    const a = getDefaultScripts();
    const b = getDefaultScripts();
    expect(a).not.toBe(b);
  });
});
