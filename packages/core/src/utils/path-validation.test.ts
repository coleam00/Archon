/**
 * Unit tests for path validation utilities
 *
 * NOTE: These tests use dynamic imports and module cache clearing
 * to test different WORKSPACE_PATH configurations.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { resolve, join } from 'path';
import { homedir } from 'os';

// Helper to import fresh module with cleared cache
async function importFresh() {
  // Clear the module from cache by deleting it from Loader registry
  const modulePath = require.resolve('./path-validation');
  const archonPathsModulePath = require.resolve('@archon/paths');
  delete require.cache[modulePath];
  delete require.cache[archonPathsModulePath];
  return import('./path-validation');
}

// Default archon workspaces path
function getDefaultWorkspacesPath(): string {
  return join(homedir(), '.archon', 'workspaces');
}

describe('path-validation', () => {
  const originalWorkspacePath = process.env.WORKSPACE_PATH;
  const originalArchonHome = process.env.ARCHON_HOME;
  const originalArchonDocker = process.env.ARCHON_DOCKER;

  beforeEach(() => {
    // Reset to default for consistent test behavior (clear Docker detection too)
    delete process.env.WORKSPACE_PATH;
    delete process.env.ARCHON_HOME;
    delete process.env.ARCHON_DOCKER;
  });

  afterAll(() => {
    // Restore original env vars
    if (originalWorkspacePath !== undefined) {
      process.env.WORKSPACE_PATH = originalWorkspacePath;
    } else {
      delete process.env.WORKSPACE_PATH;
    }
    if (originalArchonHome !== undefined) {
      process.env.ARCHON_HOME = originalArchonHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
    if (originalArchonDocker !== undefined) {
      process.env.ARCHON_DOCKER = originalArchonDocker;
    } else {
      delete process.env.ARCHON_DOCKER;
    }
  });

  describe('isPathWithinWorkspace', () => {
    test('should allow paths within default archon workspaces', async () => {
      const { isPathWithinWorkspace } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(isPathWithinWorkspace(`${defaultPath}/repo`)).toBe(true);
      expect(isPathWithinWorkspace(`${defaultPath}/repo/src`)).toBe(true);
      expect(isPathWithinWorkspace(defaultPath)).toBe(true);
    });

    test('should allow relative paths that resolve within workspace', async () => {
      const { isPathWithinWorkspace } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(isPathWithinWorkspace('repo', defaultPath)).toBe(true);
      expect(isPathWithinWorkspace('./repo', defaultPath)).toBe(true);
      expect(isPathWithinWorkspace('repo/src/file.ts', defaultPath)).toBe(true);
    });

    test('should reject path traversal attempts', async () => {
      const { isPathWithinWorkspace } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(isPathWithinWorkspace(`${defaultPath}/../etc/passwd`)).toBe(false);
      expect(isPathWithinWorkspace('../etc/passwd', defaultPath)).toBe(false);
      expect(isPathWithinWorkspace(`${defaultPath}/repo/../../etc/passwd`)).toBe(false);
      expect(isPathWithinWorkspace('foo/../../../etc/passwd', defaultPath)).toBe(false);
    });

    test('should reject paths outside workspace', async () => {
      const { isPathWithinWorkspace } = await importFresh();
      expect(isPathWithinWorkspace('/etc/passwd')).toBe(false);
      expect(isPathWithinWorkspace('/tmp/file')).toBe(false);
      expect(isPathWithinWorkspace('/var/log/syslog')).toBe(false);
    });

    test('should reject paths that look similar but are outside workspace', async () => {
      const { isPathWithinWorkspace } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(isPathWithinWorkspace(`${defaultPath}-other`)).toBe(false);
    });

    test('should use ARCHON_HOME env var when set', async () => {
      process.env.ARCHON_HOME = '/custom/archon';
      const { isPathWithinWorkspace } = await importFresh();
      expect(isPathWithinWorkspace('/custom/archon/workspaces/repo')).toBe(true);
      const defaultPath = getDefaultWorkspacesPath();
      expect(isPathWithinWorkspace(`${defaultPath}/repo`)).toBe(false); // Default path now rejected
    });
  });

  describe('validateAndResolvePath', () => {
    test('should return resolved path for valid paths', async () => {
      const { validateAndResolvePath } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(validateAndResolvePath(`${defaultPath}/repo`)).toBe(resolve(`${defaultPath}/repo`));
      expect(validateAndResolvePath('repo', defaultPath)).toBe(resolve(`${defaultPath}/repo`));
      expect(validateAndResolvePath('./src', `${defaultPath}/repo`)).toBe(
        resolve(`${defaultPath}/repo/src`)
      );
    });

    test('should throw for path traversal attempts', async () => {
      const { validateAndResolvePath } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(() => validateAndResolvePath('../etc/passwd', defaultPath)).toThrow(
        `Path must be within ${defaultPath} directory`
      );
      expect(() => validateAndResolvePath(`${defaultPath}/../etc/passwd`)).toThrow(
        `Path must be within ${defaultPath} directory`
      );
    });

    test('should throw for paths outside workspace', async () => {
      const { validateAndResolvePath } = await importFresh();
      const defaultPath = getDefaultWorkspacesPath();
      expect(() => validateAndResolvePath('/etc/passwd')).toThrow(
        `Path must be within ${defaultPath} directory`
      );
      expect(() => validateAndResolvePath('/tmp/evil')).toThrow(
        `Path must be within ${defaultPath} directory`
      );
    });

    test('should use custom ARCHON_HOME for validation and error message', async () => {
      process.env.ARCHON_HOME = '/my/custom/archon';
      const { validateAndResolvePath } = await importFresh();
      const customWorkspace = resolve('/my/custom/archon/workspaces');
      // Valid path under custom workspace
      expect(validateAndResolvePath('/my/custom/archon/workspaces/repo')).toBe(
        resolve('/my/custom/archon/workspaces/repo')
      );
      // Path under default workspace should now throw with custom workspace in message
      const defaultPath = getDefaultWorkspacesPath();
      expect(() => validateAndResolvePath(`${defaultPath}/repo`)).toThrow(
        `Path must be within ${customWorkspace} directory`
      );
    });
  });
});
