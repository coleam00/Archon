/**
 * Tests for the user-global script fallback in executeScriptNode.
 *
 * Isolated in its own test file (and its own bun test invocation — see package.json)
 * because it mocks @archon/paths differently than dag-executor.test.ts:
 * this file needs getArchonHome to return the test-controlled ARCHON_HOME,
 * whereas dag-executor.test.ts points getArchonHome at /nonexistent/archon-home
 * to neutralize the fallback. Two files cannot mock.module() the same path
 * with different implementations in one batch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { mkdir, writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock logger + @archon/paths (must come before imports under test) ---

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string): string[] => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: (): string => '/nonexistent/defaults',
  getArchonHome: (): string => {
    const envHome = process.env.ARCHON_HOME;
    if (!envHome) throw new Error('ARCHON_HOME not set in test');
    return envHome;
  },
}));

// --- Imports (after mocks) ---
import { executeDagWorkflow } from './dag-executor';
import type { ScriptNode, WorkflowRun } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

// --- Shared mock factories (duplicated from dag-executor.test.ts intentionally;
//     keeping this file self-contained avoids cross-file import coupling) ---

function createMockStore(): IWorkflowStore {
  const dummyRun = {
    id: 'mock-run-id',
    workflow_name: 'mock',
    conversation_id: 'conv-mock',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running' as const,
    user_message: 'mock message',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
  return {
    createWorkflowRun: mock(() => Promise.resolve(dummyRun)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() => Promise.resolve(dummyRun)),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  };
}

const mockSendQuery = mock(function* () {
  yield { type: 'assistant', content: 'not used in script tests' };
  yield { type: 'result', sessionId: 'session' };
});

const mockGetAssistantClient = mock(() => ({
  sendQuery: mockSendQuery,
  getType: () => 'claude',
}));

function createMockDeps(): WorkflowDeps {
  return {
    store: createMockStore(),
    getAssistantClient: mockGetAssistantClient,
    loadConfig: mock(() =>
      Promise.resolve({
        assistant: 'claude' as const,
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        assistants: { claude: {}, codex: {} },
      })
    ),
  };
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

function makeRun(id: string): WorkflowRun {
  return {
    id,
    workflow_name: 'script-global-test',
    conversation_id: `conv-${id}`,
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
  };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

// --- Tests ---

describe('executeScriptNode — user-global fallback', () => {
  let repoCwd: string;
  let globalHome: string;

  beforeAll(async () => {
    repoCwd = await mkdtemp(join(tmpdir(), 'archon-script-repo-'));
    globalHome = await mkdtemp(join(tmpdir(), 'archon-script-home-'));
    process.env.ARCHON_HOME = globalHome;
    // Subdirs the workflow needs
    await mkdir(join(repoCwd, 'artifacts'), { recursive: true });
    await mkdir(join(repoCwd, 'logs'), { recursive: true });
  });

  afterAll(async () => {
    await rm(repoCwd, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    delete process.env.ARCHON_HOME;
  });

  beforeEach(async () => {
    // Wipe .archon dirs between tests
    await rm(join(repoCwd, '.archon'), { recursive: true, force: true });
    await rm(join(globalHome, '.archon'), { recursive: true, force: true });
  });

  it('executes a named script found only in the user-global .archon/scripts/', async () => {
    // No repo-local script; only the global one
    const globalScripts = join(globalHome, '.archon', 'scripts');
    await mkdir(globalScripts, { recursive: true });
    await writeFile(join(globalScripts, 'greet-global.ts'), 'console.log("hello from global")');

    const platform = createMockPlatform();
    const node: ScriptNode = {
      id: 'run-greet-global',
      script: 'greet-global',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      createMockDeps(),
      platform,
      'conv-global',
      repoCwd,
      { name: 'script-global-test', nodes: [node] },
      makeRun('script-global-only-run'),
      'claude',
      undefined,
      join(repoCwd, 'artifacts'),
      join(repoCwd, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    // No "not found" message should have been sent
    const notFound = messages.find(m => m.includes('not found'));
    expect(notFound).toBeUndefined();
    // No workflow-level failure message
    const failed = messages.find(m => m.includes('no successful nodes'));
    expect(failed).toBeUndefined();
  });

  it('prefers the repo-local copy over the user-global copy when both exist', async () => {
    // Put a working script in BOTH locations; give them distinguishable output
    const repoScripts = join(repoCwd, '.archon', 'scripts');
    const globalScripts = join(globalHome, '.archon', 'scripts');
    await mkdir(repoScripts, { recursive: true });
    await mkdir(globalScripts, { recursive: true });
    await writeFile(join(repoScripts, 'shared.ts'), 'console.log("from-repo")');
    await writeFile(join(globalScripts, 'shared.ts'), 'console.log("from-global")');

    const capturedStore = createMockStore();
    const deps: WorkflowDeps = {
      ...createMockDeps(),
      store: capturedStore,
    };

    const platform = createMockPlatform();
    const node: ScriptNode = { id: 'run-shared', script: 'shared', runtime: 'bun' };

    await executeDagWorkflow(
      deps,
      platform,
      'conv-shared',
      repoCwd,
      { name: 'script-shared-test', nodes: [node] },
      makeRun('script-shared-run'),
      'claude',
      undefined,
      join(repoCwd, 'artifacts'),
      join(repoCwd, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    // Find the node_completed event and check its captured output contains 'from-repo'
    const createEvent = capturedStore.createWorkflowEvent as ReturnType<typeof mock>;
    const nodeCompletedCall = createEvent.mock.calls.find((call: unknown[]) => {
      const event = call[0] as { event_type: string; step_name?: string };
      return event.event_type === 'node_completed' && event.step_name === 'run-shared';
    });
    expect(nodeCompletedCall).toBeDefined();
    if (nodeCompletedCall) {
      const event = nodeCompletedCall[0] as { data?: { node_output?: string } };
      expect(event.data?.node_output).toContain('from-repo');
      expect(event.data?.node_output).not.toContain('from-global');
    }
  });

  it('fails with the updated error message when missing in both repo and global', async () => {
    // Neither dir has the script
    const platform = createMockPlatform();
    const node: ScriptNode = {
      id: 'missing-script',
      script: 'nowhere',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      createMockDeps(),
      platform,
      'conv-missing',
      repoCwd,
      { name: 'script-missing-test', nodes: [node] },
      makeRun('script-missing-run'),
      'claude',
      undefined,
      join(repoCwd, 'artifacts'),
      join(repoCwd, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
    const messages = sendMessage.mock.calls.map((call: unknown[]) => call[1] as string);
    const notFoundMsg = messages.find(m =>
      m.includes('not found in .archon/scripts/ (repo, workspace, or global)')
    );
    expect(notFoundMsg).toBeDefined();
  });
});

// ─── Workspace-in-userspace tier (repo > workspace > global) ────────────────

describe('executeScriptNode — workspace-in-userspace fallback', () => {
  let repoCwd: string;
  let globalHome: string;
  // The workspace search path stands in for `~/.archon/workspaces/<owner>/<repo>/`
  // — the PROJECT ROOT. The engine probes `<root>/.archon/scripts/<name>.ts`.
  let workspaceSearchPath: string;

  beforeAll(async () => {
    repoCwd = await mkdtemp(join(tmpdir(), 'archon-script-wsr-repo-'));
    globalHome = await mkdtemp(join(tmpdir(), 'archon-script-wsr-home-'));
    workspaceSearchPath = await mkdtemp(join(tmpdir(), 'archon-script-wsr-workspace-'));
    process.env.ARCHON_HOME = globalHome;
    await mkdir(join(repoCwd, 'artifacts'), { recursive: true });
    await mkdir(join(repoCwd, 'logs'), { recursive: true });
  });

  afterAll(async () => {
    await rm(repoCwd, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    await rm(workspaceSearchPath, { recursive: true, force: true });
    delete process.env.ARCHON_HOME;
  });

  beforeEach(async () => {
    await rm(join(repoCwd, '.archon'), { recursive: true, force: true });
    await rm(join(globalHome, '.archon'), { recursive: true, force: true });
    await rm(join(workspaceSearchPath, '.archon'), { recursive: true, force: true });
  });

  /**
   * Dispatch a workflow with a script node, passing workspaceArchonDir through
   * via the last-parameter hole in executeDagWorkflow. The engine will use
   * the explicitly-provided value and skip its own git-based lookup.
   */
  async function runWithWorkspace(
    platform: IWorkflowPlatform,
    runId: string,
    scriptName: string
  ): Promise<IWorkflowStore> {
    const store = createMockStore();
    const deps: WorkflowDeps = {
      ...createMockDeps(),
      store,
    };
    const node: ScriptNode = { id: 'run-it', script: scriptName, runtime: 'bun' };
    await executeDagWorkflow(
      deps,
      platform,
      `conv-${runId}`,
      repoCwd,
      { name: `script-wsr-${runId}`, nodes: [node] },
      makeRun(runId),
      'claude',
      undefined,
      join(repoCwd, 'artifacts'),
      join(repoCwd, 'logs'),
      'main',
      'docs/',
      minimalConfig,
      undefined, // configuredCommandFolder
      undefined, // issueContext
      undefined, // priorCompletedNodes
      workspaceSearchPath // workspaceSearchPath (project root)
    );
    return store;
  }

  it('executes a script found only in the workspace dir', async () => {
    await mkdir(join(workspaceSearchPath, '.archon', 'scripts'), { recursive: true });
    await writeFile(
      join(workspaceSearchPath, '.archon', 'scripts', 'ws-only.ts'),
      'console.log("from-workspace")'
    );

    const platform = createMockPlatform();
    const store = await runWithWorkspace(platform, 'ws-only-run', 'ws-only');

    const createEvent = store.createWorkflowEvent as ReturnType<typeof mock>;
    const nodeCompleted = createEvent.mock.calls.find((call: unknown[]) => {
      const event = call[0] as { event_type: string; step_name?: string };
      return event.event_type === 'node_completed' && event.step_name === 'run-it';
    });
    expect(nodeCompleted).toBeDefined();
    if (nodeCompleted) {
      const event = nodeCompleted[0] as { data?: { node_output?: string } };
      expect(event.data?.node_output).toContain('from-workspace');
    }
  });

  it('prefers repo over workspace', async () => {
    await mkdir(join(repoCwd, '.archon', 'scripts'), { recursive: true });
    await mkdir(join(workspaceSearchPath, '.archon', 'scripts'), { recursive: true });
    await writeFile(join(repoCwd, '.archon', 'scripts', 'dup.ts'), 'console.log("from-repo")');
    await writeFile(
      join(workspaceSearchPath, '.archon', 'scripts', 'dup.ts'),
      'console.log("from-workspace")'
    );

    const platform = createMockPlatform();
    const store = await runWithWorkspace(platform, 'dup-run', 'dup');

    const createEvent = store.createWorkflowEvent as ReturnType<typeof mock>;
    const nodeCompleted = createEvent.mock.calls.find((call: unknown[]) => {
      const event = call[0] as { event_type: string; step_name?: string };
      return event.event_type === 'node_completed' && event.step_name === 'run-it';
    });
    expect(nodeCompleted).toBeDefined();
    if (nodeCompleted) {
      const event = nodeCompleted[0] as { data?: { node_output?: string } };
      expect(event.data?.node_output).toContain('from-repo');
      expect(event.data?.node_output).not.toContain('from-workspace');
    }
  });

  it('prefers workspace over user-global', async () => {
    await mkdir(join(workspaceSearchPath, '.archon', 'scripts'), { recursive: true });
    await mkdir(join(globalHome, '.archon', 'scripts'), { recursive: true });
    await writeFile(
      join(workspaceSearchPath, '.archon', 'scripts', 'mid.ts'),
      'console.log("from-workspace")'
    );
    await writeFile(join(globalHome, '.archon', 'scripts', 'mid.ts'), 'console.log("from-global")');

    const platform = createMockPlatform();
    const store = await runWithWorkspace(platform, 'mid-run', 'mid');

    const createEvent = store.createWorkflowEvent as ReturnType<typeof mock>;
    const nodeCompleted = createEvent.mock.calls.find((call: unknown[]) => {
      const event = call[0] as { event_type: string; step_name?: string };
      return event.event_type === 'node_completed' && event.step_name === 'run-it';
    });
    expect(nodeCompleted).toBeDefined();
    if (nodeCompleted) {
      const event = nodeCompleted[0] as { data?: { node_output?: string } };
      expect(event.data?.node_output).toContain('from-workspace');
      expect(event.data?.node_output).not.toContain('from-global');
    }
  });
});
