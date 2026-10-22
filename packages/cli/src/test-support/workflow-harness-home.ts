/** The test ARCHON_HOME each test gets, and the `@archon/paths` fake that resolves it. */
import { beforeAll, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDocker } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  getProjectStoragePaths as getProjectStoragePathsReal,
  getRunArtifactsDirForRoot as getRunArtifactsDirForRootReal,
  getRunLogPathForRoot as getRunLogPathForRootReal,
  isInsideArchonHome as isInsideArchonHomeReal,
  resolveProjectStorageKey as resolveProjectStorageKeyReal,
  resolveRunStorageRoot as resolveRunStorageRootReal,
} from '@archon/paths/archon-paths';

beforeAll(async () => {
  const { registerBuiltinProviders, registerCommunityProviders } = await import(
    '@archon/providers/in-process'
  );
  registerBuiltinProviders();
  registerCommunityProviders();
});

export let testHome: string;
let inheritedHome: string | undefined;
let inheritedDocker: string | undefined;
let inheritedWorkspace: string | undefined;

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'archon-workflow-test-home-'));
  inheritedHome = process.env.ARCHON_HOME;
  inheritedDocker = process.env.ARCHON_DOCKER;
  inheritedWorkspace = process.env.WORKSPACE_PATH;
  process.env.ARCHON_DOCKER = '';
  process.env.WORKSPACE_PATH = '';
  process.env.ARCHON_HOME = testHome;
  const core = await import('@archon/core');
  (core.loadConfig as ReturnType<typeof mock>).mockResolvedValue({
    defaults: {},
    assistant: 'claude',
    assistants: { claude: {} },
    aliases: { '@planner': { provider: 'claude', model: 'sonnet' } },
    commands: {},
  });
});

afterEach(async () => {
  if (inheritedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = inheritedHome;
  if (inheritedDocker === undefined) delete process.env.ARCHON_DOCKER;
  else process.env.ARCHON_DOCKER = inheritedDocker;
  if (inheritedWorkspace === undefined) delete process.env.WORKSPACE_PATH;
  else process.env.WORKSPACE_PATH = inheritedWorkspace;
  await removeTempTree(testHome);
});

export const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

const mockExpandTilde = (path: string): string =>
  path.startsWith('~') ? join(homedir(), path.slice(1).replace(/^[/\\]/, '')) : path;
// Identity by default: fixture paths are fake and must keep their spelling on Windows.
export const mockCanonicalizeProjectPath = mock(async (path: string) => path);

// Mock @archon/paths (createLogger moved here from @archon/core)
mock.module('@archon/paths', () => ({
  canonicalizeProjectPath: mockCanonicalizeProjectPath,
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  expandTilde: mockExpandTilde,
  isDocker,
  getArchonHome: mock((env: NodeJS.ProcessEnv = process.env) =>
    isDocker(env) ? '/.archon' : env.ARCHON_HOME ? mockExpandTilde(env.ARCHON_HOME) : testHome
  ),
  getProjectStoragePaths: getProjectStoragePathsReal,
  getRunArtifactsDirForRoot: getRunArtifactsDirForRootReal,
  getRunLogPathForRoot: getRunLogPathForRootReal,
  isInsideArchonHome: isInsideArchonHomeReal,
  resolveProjectStorageKey: resolveProjectStorageKeyReal,
  resolveRunStorageRoot: resolveRunStorageRootReal,
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: '0.0.0-test',
  readTierNoticeState: mock(() => null),
  markTierNoticeShown: mock(() => undefined),
}));
