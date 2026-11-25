import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'fs';
import {
  getAppArchonBasePath,
  getSourceWebDistDir,
  getBundledWorkflowsPath,
  runningBuildInsideWorkspaces,
  validateAppDefaultsPaths,
} from './source-tree-paths';
import { trackTempRoots, usePathEnvSnapshot } from './test-utils';

describe('source-tree-paths', () => {
  usePathEnvSnapshot();

  describe('getAppArchonBasePath', () => {
    test('path exists and contains defaults directories', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getAppArchonBasePath();
      // The path should end with .archon and the directory should exist
      expect(path).toMatch(/\.archon$/);
      expect(existsSync(path)).toBe(true);
    });
  });

  describe('getSourceWebDistDir', () => {
    test('points at the web package build output in this checkout', () => {
      const path = getSourceWebDistDir();
      expect(path.endsWith(join('packages', 'web', 'dist'))).toBe(true);
      // Anchored on the package that owns the build rather than on a second copy
      // of the same path arithmetic: `bun run build:web` writes this directory,
      // and `archon serve` refuses to start without it.
      const webPackageJson = join(dirname(path), 'package.json');
      expect(existsSync(webPackageJson)).toBe(true);
      expect(JSON.parse(readFileSync(webPackageJson, 'utf8')).name).toBe('@archon/web');
    });
  });

  describe('getBundledWorkflowsPath', () => {
    test('returns workflows under app archon base', () => {
      delete process.env.ARCHON_DOCKER;
      delete process.env.WORKSPACE_PATH;
      const path = getBundledWorkflowsPath();
      expect(path).toBe(join(getAppArchonBasePath(), 'workflows'));
      expect(path).not.toContain('packages/core');
    });
  });
});

describe('validateAppDefaultsPaths', () => {
  test('does not throw for valid paths', async () => {
    await expect(validateAppDefaultsPaths()).resolves.toBeUndefined();
  });
});

describe('runningBuildInsideWorkspaces', () => {
  usePathEnvSnapshot();
  const trackTempRoot = trackTempRoots();
  function inHome(home: string, build: string): string | null {
    delete process.env.ARCHON_DOCKER;
    delete process.env.WORKSPACE_PATH;
    process.env.ARCHON_HOME = home;
    return runningBuildInsideWorkspaces(build);
  }
  function makeRoot(): string {
    return realpathSync(trackTempRoot(mkdtempSync(join(tmpdir(), 'build-in-workspaces-'))));
  }

  test('returns the build when it sits inside the home workspaces', () => {
    const home = makeRoot();
    const build = join(home, 'workspaces', 'owner', 'repo', 'worktrees', 'task');
    mkdirSync(build, { recursive: true });
    expect(inHome(home, build)).toBe(build);
  });

  test('returns null for a build outside the home workspaces', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const build = join(root, 'checkout');
    mkdirSync(join(home, 'workspaces'), { recursive: true });
    mkdirSync(build);
    expect(inHome(home, build)).toBeNull();
  });

  test('returns null when a workspaces symlink only points at the build', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const build = join(root, 'checkout');
    mkdirSync(join(home, 'workspaces', 'owner', 'repo'), { recursive: true });
    mkdirSync(build);
    symlinkSync(build, join(home, 'workspaces', 'owner', 'repo', 'source'), 'junction');
    expect(inHome(home, join(home, 'workspaces', 'owner', 'repo', 'source'))).toBeNull();
  });

  test('follows a home whose workspaces directory is a symlink', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const build = join(root, 'elsewhere', 'task');
    mkdirSync(home);
    mkdirSync(build, { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(home, 'workspaces'), 'junction');
    expect(inHome(home, build)).toBe(build);
  });

  test('returns null for a home with no workspaces directory', () => {
    const home = makeRoot();
    expect(inHome(home, home)).toBeNull();
  });
});
