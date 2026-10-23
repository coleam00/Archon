/**
 * Shared fixture for the config suites: the @archon/paths and fs/promises mocks the
 * loader reads through, the registered providers, and useConfigTestEnv, which a suite
 * calls inside its describe to reset the config cache, the mocks and the env vars the
 * loader reads. Import it after the module under test: a module mock replaces the
 * exports of a module that is already loaded, but a `const` export of one loaded later
 * keeps its real value.
 */
import { afterEach, beforeEach, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import { createMockLogger } from '../test/mocks/logger';
import { setPlatformPolicies } from '../platforms/registry';
import type { PlatformPolicy } from '../platforms/types';
import { clearConfigCache } from './config-loader';

export const mockLogger = createMockLogger();
export const archonHome = join(homedir(), '.archon');
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => archonHome),
  getArchonConfigPath: mock(() => join(archonHome, 'config.yaml')),
  getBundledWorkflowsPath: mock(() => '/app/.archon/workflows'),
}));

// Mock fs/promises so that readConfigFile/writeConfigFile (which call fsReadFile/writeFile
// internally) are intercepted regardless of Bun version mock.module semantics.
export const mockFsReadFile = mock<(path: string) => Promise<string>>(() => Promise.resolve(''));
export const mockFsWriteFile = mock<(path: string, content: string) => Promise<void>>(() =>
  Promise.resolve()
);
export const mockFsMkdir = mock<(path: string) => Promise<void>>(() => Promise.resolve());

mock.module('fs/promises', () => ({
  readFile: mockFsReadFile,
  writeFile: mockFsWriteFile,
  mkdir: mockFsMkdir,
}));

registerBuiltinProviders();
registerCommunityProviders();

export const streamtestPolicy: PlatformPolicy = {
  id: 'streamtest',
  workspaceRetention: 'age-based',
  streaming: { defaultMode: 'stream', envVar: 'STREAMTEST_STREAMING_MODE' },
};
export const matrixPolicy: PlatformPolicy = {
  id: 'matrix-chat',
  workspaceRetention: 'age-based',
  streaming: { defaultMode: 'stream', envVar: 'MATRIX_STREAMING_MODE' },
};

const envVars = [
  'DEFAULT_AI_ASSISTANT',
  'STREAMTEST_STREAMING_MODE',
  'MATRIX_STREAMING_MODE',
  'MAX_CONCURRENT_CONVERSATIONS',
  'WORKSPACE_PATH',
  'WORKTREE_BASE',
  'ARCHON_HOME',
];

export function useConfigTestEnv(): void {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    setPlatformPolicies([streamtestPolicy]);
    clearConfigCache();
    mockFsReadFile.mockReset();
    mockFsWriteFile.mockReset();

    // Save original env vars
    envVars.forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    // Restore env vars
    envVars.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });

    // Clear mock state between tests
    mockFsReadFile.mockClear();
    mockFsWriteFile.mockClear();
  });
}
