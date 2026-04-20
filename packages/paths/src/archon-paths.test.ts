import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile, lstat, readlink } from 'fs/promises';

const isWindows = process.platform === 'win32';

import {
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getHomeWorkflowsPath,
  getHomeCommandsPath,
  getLegacyHomeWorkflowsPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  expandTilde,
  getAppArchonBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logArchonPaths,
  validateAppDefaultsPaths,
  parseOwnerRepo,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
} from './archon-paths';

/** All env vars that path functions depend on */
const ENV_VARS = ['WORKSPACE_PATH', 'WORKTREE_BASE', 'ARCHON_HOME', 'ARCHON_DOCKER', 'HOME'];

/**
 * Save and restore environment variables around each test.
 * Call at the top of a describe block to register beforeEach/afterEach hooks.
 */
function useEnvSnapshot(): void {
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_VARS) {
      snapshot[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  });
}

describe('archon-paths', () => {
  useEnvSnapshot();

  describe('expandTilde', () => {
    test('expands ~ to home directory', () => {
      expect(expandTilde('~/test')).toBe(join(homedir(), 'test'));
    });

    test('returns path unchanged if no tilde', () => {
      expect(expandTilde('/absolute/path')).toBe('/absolute/path');
    });
  });

  describe('isDocker', () => {
    test('returns true when WORKSPACE_PATH is /workspace', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when HOME=/root and WORKSPACE_PATH set', () => {
      process.env.HOME = '/root';
      process.env.WORKSPACE_PATH = '/app/workspace';
      expect(isDocker()).toBe(true);
    });

    test('returns true when ARCHON_DOCKER=true', () => {
      delete process.env.WORKSPACE_PATH;
      process.env.ARCHON_DOCKER = 'true';
      expect(isDocker()).toBe(true);
    });

    test('returns false for local development', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.HOME = homedir();
      expect(isDocker()).toBe(false);
    });
  });

  describe('getArchonHome', () => {
    test('returns /.archon in Docker', () => {
      process.env.WORKSPACE_PATH = '/workspace';
      expect(getArchonHome()).toBe('/.archon');
    });

    test('returns ARCHON_HOME when set (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonHome()).toBe('/custom/archon');
    });

    test('expands tilde in ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '~/my-archon';
      expect(getArchonHome()).toBe(join(homedir(), 'my-archon'));
    });

    test('returns ~/.archon by default (local)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonHome()).toBe(join(homedir(), '.archon'));
    });
  });

  describe('getArchonWorkspacesPath', () => {
    test('returns ~/.archon/workspaces by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorkspacesPath()).toBe(join(homedir(), '.archon', 'workspaces'));
    });

    test('returns /.archon/workspaces in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getArchonWorkspacesPath()).toBe(join('/', '.archon', 'workspaces'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonWorkspacesPath()).toBe(join('/custom/archon', 'workspaces'));
    });
  });

  describe('getArchonWorktreesPath', () => {
    test('returns ~/.archon/worktrees by default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonWorktreesPath()).toBe(join(homedir(), '.archon', 'worktrees'));
    });

    test('returns /.archon/worktrees in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getArchonWorktreesPath()).toBe(join('/', '.archon', 'worktrees'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getArchonWorktreesPath()).toBe(join('/custom/archon', 'worktrees'));
    });
  });

  describe('getCommandFolderSearchPaths', () => {
    test('returns .archon/commands and defaults by default', () => {
      const paths = getCommandFolderSearchPaths();
      expect(paths).toEqual(['.archon/commands', '.archon/commands/defaults']);
    });

    test('includes configured folder when provided', () => {
      const paths = getCommandFolderSearchPaths('.claude/commands/archon');
      expect(paths).toEqual([
        '.archon/commands',
        '.archon/commands/defaults',
        '.claude/commands/archon',
      ]);
    });

    test('.archon/commands has highest priority', () => {
      const paths = getCommandFolderSearchPaths('.custom/commands');
      expect(paths[0]).toBe('.archon/commands');
    });

    test('.archon/commands/defaults has second priority', () => {
      const paths = getCommandFolderSearchPaths('.custom/commands');
      expect(paths[1]).toBe('.archon/commands/defaults');
    });

    test('does not duplicate .archon/commands if configured', () => {
      const paths = getCommandFolderSearchPaths('.archon/commands');
      expect(paths).toEqual(['.archon/commands', '.archon/commands/defaults']);
    });

    test('does not duplicate .archon/commands/defaults if configured', () => {
      const paths = getCommandFolderSearchPaths('.archon/commands/defaults');
      expect(paths).toEqual(['.archon/commands', '.archon/commands/defaults']);
    });
  });

  describe('getWorkflowFolderSearchPaths', () => {
    test('returns .archon/workflows', () => {
      const paths = getWorkflowFolderSearchPaths();
      expect(paths).toEqual(['.archon/workflows']);
    });
  });

  describe('getArchonConfigPath', () => {
    test('returns path to config.yaml', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getArchonConfigPath()).toBe(join(homedir(), '.archon', 'config.yaml'));
    });
  });

  describe('getHomeWorkflowsPath', () => {
    test('returns ~/.archon/workflows by default (direct child of ~/.archon/)', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeWorkflowsPath()).toBe(join(homedir(), '.archon', 'workflows'));
    });

    test('returns /.archon/workflows in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getHomeWorkflowsPath()).toBe(join('/', '.archon', 'workflows'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getHomeWorkflowsPath()).toBe(join('/custom/archon', 'workflows'));
    });

    test('no double `.archon/` nesting — must sit next to workspaces/ and worktrees/', () => {
      // Regression guard: the old location was ~/.archon/.archon/workflows/.
      // New location must NOT reintroduce the double-nested path.
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeWorkflowsPath()).not.toContain(join('.archon', '.archon'));
    });
  });

  describe('getHomeCommandsPath', () => {
    test('returns ~/.archon/commands by default', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getHomeCommandsPath()).toBe(join(homedir(), '.archon', 'commands'));
    });

    test('returns /.archon/commands in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getHomeCommandsPath()).toBe(join('/', '.archon', 'commands'));
    });

    test('uses ARCHON_HOME when set', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getHomeCommandsPath()).toBe(join('/custom/archon', 'commands'));
    });
  });

  describe('getLegacyHomeWorkflowsPath', () => {
    // This helper only exists so discovery can DETECT files at the old location
    // and emit a deprecation warning. It is not a fallback read path.
    test('returns ~/.archon/.archon/workflows (the retired location)', () => {
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getLegacyHomeWorkflowsPath()).toBe(join(homedir(), '.archon', '.archon', 'workflows'));
    });

    test('honors ARCHON_HOME so migration detection works in custom setups', () => {
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getLegacyHomeWorkflowsPath()).toBe(join('/custom/archon', '.archon', 'workflows'));
    });
  });

  describe('getAppArchonBasePath', () => {
    test('returns repo root .archon path in local development', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getAppArchonBasePath();
      // Should end with .archon and NOT contain packages/core or packages/paths
      expect(path).toMatch(/\.archon$/);
      expect(path).not.toContain('packages/core');
      expect(path).not.toContain('packages/paths');
    });

    test('path exists and contains defaults directories', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getAppArchonBasePath();
      // The path should end with .archon and the directory should exist
      expect(path).toMatch(/\.archon$/);
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('getDefaultCommandsPath', () => {
    test('returns commands/defaults under app archon base', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getDefaultCommandsPath();
      expect(path).toContain('.archon');
      expect(path).toContain('commands');
      expect(path).toContain('defaults');
      expect(path).not.toContain('packages/core');
    });
  });

  describe('getDefaultWorkflowsPath', () => {
    test('returns workflows/defaults under app archon base', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getDefaultWorkflowsPath();
      expect(path).toContain('.archon');
      expect(path).toContain('workflows');
      expect(path).toContain('defaults');
      expect(path).not.toContain('packages/core');
    });
  });

  // =========================================================================
  // Project-centric path functions
  // =========================================================================

  describe('parseOwnerRepo', () => {
    test('parses owner/repo format', () => {
      expect(parseOwnerRepo('acme/widget')).toEqual({ owner: 'acme', repo: 'widget' });
    });

    test('returns null for bare name', () => {
      expect(parseOwnerRepo('widget')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseOwnerRepo('')).toBeNull();
    });

    test('returns null for trailing slash', () => {
      expect(parseOwnerRepo('acme/')).toBeNull();
    });

    test('returns null for leading slash', () => {
      expect(parseOwnerRepo('/widget')).toBeNull();
    });

    test('rejects nested paths with more than one slash', () => {
      const result = parseOwnerRepo('acme/nested/widget');
      expect(result).toBeNull();
    });

    test('rejects path traversal in owner', () => {
      expect(parseOwnerRepo('../etc/passwd')).toBeNull();
    });

    test('rejects path traversal in repo', () => {
      expect(parseOwnerRepo('acme/../../etc')).toBeNull();
    });

    test('rejects dot and dotdot segments', () => {
      expect(parseOwnerRepo('./widget')).toBeNull();
      expect(parseOwnerRepo('acme/..')).toBeNull();
      expect(parseOwnerRepo('../widget')).toBeNull();
      expect(parseOwnerRepo('.')).toBeNull();
    });

    test('accepts valid GitHub-style names with dots, hyphens, underscores', () => {
      expect(parseOwnerRepo('my-org/my_repo.js')).toEqual({
        owner: 'my-org',
        repo: 'my_repo.js',
      });
    });

    test('rejects names with spaces', () => {
      expect(parseOwnerRepo('my org/repo')).toBeNull();
    });

    test('rejects names with special characters', () => {
      expect(parseOwnerRepo('acme/repo;rm -rf')).toBeNull();
      expect(parseOwnerRepo('acme/$HOME')).toBeNull();
    });
  });

  describe('getProjectRoot', () => {
    test('returns path under workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const result = getProjectRoot('acme', 'widget');
      expect(result).toBe(join(homedir(), '.archon', 'workspaces', 'acme', 'widget'));
    });

    test('respects ARCHON_HOME', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      expect(getProjectRoot('acme', 'widget')).toBe(
        join('/custom/archon', 'workspaces', 'acme', 'widget')
      );
    });

    test('works in Docker', () => {
      process.env.ARCHON_DOCKER = 'true';
      expect(getProjectRoot('acme', 'widget')).toBe(
        join('/', '.archon', 'workspaces', 'acme', 'widget')
      );
    });
  });

  describe('getProjectSourcePath', () => {
    test('appends source/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectSourcePath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'source')
      );
    });
  });

  describe('getProjectWorktreesPath', () => {
    test('appends worktrees/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectWorktreesPath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'worktrees')
      );
    });
  });

  describe('getProjectArtifactsPath', () => {
    test('appends artifacts/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectArtifactsPath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'artifacts')
      );
    });
  });

  describe('getProjectLogsPath', () => {
    test('appends logs/ to project root', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getProjectLogsPath('acme', 'widget')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'logs')
      );
    });
  });

  describe('getRunArtifactsPath', () => {
    test('returns artifacts/runs/{id}/ path', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getRunArtifactsPath('acme', 'widget', 'run-123')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'artifacts', 'runs', 'run-123')
      );
    });
  });

  describe('getRunLogPath', () => {
    test('returns logs/{id}.jsonl path', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(getRunLogPath('acme', 'widget', 'run-123')).toBe(
        join(homedir(), '.archon', 'workspaces', 'acme', 'widget', 'logs', 'run-123.jsonl')
      );
    });
  });

  describe('resolveProjectRootFromCwd', () => {
    test('resolves project root from a path under workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const workspacesPath = getArchonWorkspacesPath();
      const cwd = join(workspacesPath, 'acme', 'widget', 'source');
      expect(resolveProjectRootFromCwd(cwd)).toBe(join(workspacesPath, 'acme', 'widget'));
    });

    test('resolves from worktrees subpath', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const workspacesPath = getArchonWorkspacesPath();
      const cwd = join(workspacesPath, 'acme', 'widget', 'worktrees', 'feature-auth');
      expect(resolveProjectRootFromCwd(cwd)).toBe(join(workspacesPath, 'acme', 'widget'));
    });

    test('returns null for path outside workspaces', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      expect(resolveProjectRootFromCwd('/home/user/projects/my-repo')).toBeNull();
    });

    test('returns null for path with only owner (no repo)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const workspacesPath = getArchonWorkspacesPath();
      expect(resolveProjectRootFromCwd(join(workspacesPath, 'acme'))).toBeNull();
    });

    test('works with ARCHON_HOME override', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = join('/', 'custom', 'archon');
      const cwd = join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget', 'source');
      expect(resolveProjectRootFromCwd(cwd)).toBe(
        join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget')
      );
    });
  });
});

describe('logArchonPaths', () => {
  useEnvSnapshot();

  test('does not throw', () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_HOME;
    delete process.env.ARCHON_DOCKER;
    expect(() => logArchonPaths()).not.toThrow();
  });
});

describe('validateAppDefaultsPaths', () => {
  test('does not throw for valid paths', async () => {
    await expect(validateAppDefaultsPaths()).resolves.toBeUndefined();
  });

  test('handles missing paths gracefully', async () => {
    const originalEnv = process.env.ARCHON_DOCKER;
    process.env.ARCHON_DOCKER = 'true';
    try {
      // In Docker mode, paths won't exist — should still not throw
      await expect(validateAppDefaultsPaths()).resolves.toBeUndefined();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalEnv;
      }
    }
  });
});

// =========================================================================
// Async filesystem tests (use temp directories for isolation)
// =========================================================================

describe('ensureProjectStructure', () => {
  let tempArchonHome: string;
  useEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    tempArchonHome = join(
      tmpdir(),
      `archon-paths-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = tempArchonHome;
  });

  afterEach(async () => {
    await rm(tempArchonHome, { recursive: true, force: true });
  });

  test('creates all four project subdirectories', async () => {
    await ensureProjectStructure('acme', 'widget');

    const sourcePath = getProjectSourcePath('acme', 'widget');
    const worktreesPath = getProjectWorktreesPath('acme', 'widget');
    const artifactsPath = getProjectArtifactsPath('acme', 'widget');
    const logsPath = getProjectLogsPath('acme', 'widget');

    // All directories should exist
    expect((await lstat(sourcePath)).isDirectory()).toBe(true);
    expect((await lstat(worktreesPath)).isDirectory()).toBe(true);
    expect((await lstat(artifactsPath)).isDirectory()).toBe(true);
    expect((await lstat(logsPath)).isDirectory()).toBe(true);
  });

  test('is idempotent - safe to call twice', async () => {
    await ensureProjectStructure('acme', 'widget');
    await ensureProjectStructure('acme', 'widget');

    const sourcePath = getProjectSourcePath('acme', 'widget');
    expect((await lstat(sourcePath)).isDirectory()).toBe(true);
  });
});

describe('createProjectSourceSymlink', () => {
  let tempArchonHome: string;
  let tempTarget: string;
  useEnvSnapshot();

  beforeEach(async () => {
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_DOCKER;
    tempArchonHome = join(
      tmpdir(),
      `archon-symlink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.ARCHON_HOME = tempArchonHome;

    tempTarget = join(
      tmpdir(),
      `archon-target-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempTarget, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempArchonHome, { recursive: true, force: true });
    await rm(tempTarget, { recursive: true, force: true });
  });

  test.skipIf(isWindows)('creates a symlink pointing to the target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(tempTarget);
  });

  test.skipIf(isWindows)('is a no-op if symlink already points to same target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);
    // Call again - should not throw
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    expect(await readlink(linkPath)).toBe(tempTarget);
  });

  test.skipIf(isWindows)('throws when symlink points to a different target', async () => {
    await ensureProjectStructure('acme', 'widget');
    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const otherTarget = join(tmpdir(), 'other-target');
    await mkdir(otherTarget, { recursive: true });

    try {
      await expect(createProjectSourceSymlink('acme', 'widget', otherTarget)).rejects.toThrow(
        'already points to'
      );
    } finally {
      await rm(otherTarget, { recursive: true, force: true });
    }
  });

  test.skipIf(isWindows)(
    'is a no-op when real directory with contents exists (clone case)',
    async () => {
      await ensureProjectStructure('acme', 'widget');

      // Put a file in the source dir to simulate a clone
      const sourcePath = getProjectSourcePath('acme', 'widget');
      await writeFile(join(sourcePath, 'README.md'), '# Hello');

      // Should not overwrite the directory with a symlink
      await createProjectSourceSymlink('acme', 'widget', tempTarget);

      const stats = await lstat(sourcePath);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
    }
  );

  test.skipIf(isWindows)(
    'replaces empty directory with symlink (ensureProjectStructure case)',
    async () => {
      await ensureProjectStructure('acme', 'widget');

      // source/ is empty from ensureProjectStructure
      await createProjectSourceSymlink('acme', 'widget', tempTarget);

      const linkPath = getProjectSourcePath('acme', 'widget');
      const stats = await lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(tempTarget);
    }
  );

  test.skipIf(isWindows)('creates symlink when source path does not exist', async () => {
    // Only create the parent, not the source dir itself
    const projectRoot = getProjectRoot('acme', 'widget');
    await mkdir(projectRoot, { recursive: true });

    await createProjectSourceSymlink('acme', 'widget', tempTarget);

    const linkPath = getProjectSourcePath('acme', 'widget');
    const stats = await lstat(linkPath);
    expect(stats.isSymbolicLink()).toBe(true);
  });
});
