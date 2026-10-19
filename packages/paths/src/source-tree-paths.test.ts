import { describe, test, expect } from 'bun:test';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  getAppArchonBasePath,
  getSourceWebDistDir,
  getBundledWorkflowsPath,
  validateAppDefaultsPaths,
} from './source-tree-paths';
import { usePathEnvSnapshot } from './test-utils';

describe('source-tree-paths', () => {
  usePathEnvSnapshot();

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
