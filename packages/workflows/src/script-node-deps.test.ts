/**
 * Tests for US-005: dependency installation (deps field) in script nodes.
 *
 * These tests mock @archon/git's execFileAsync to verify command construction
 * without actually running uv/bun, and are isolated from dag-executor.test.ts
 * to avoid mock.module() pollution.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock @archon/git BEFORE any imports that depend on it ---

const mockExecFileAsync = mock(
  async (_cmd: string, _args: string[], _opts?: unknown) =>
    ({ stdout: '', stderr: '' }) as { stdout: string; stderr: string }
);

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
  mkdirAsync: mock(async () => undefined),
}));

// --- Mock logger (MUST come before module-under-test imports) ---

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
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getDefaultCommandsPath: () => '/nonexistent/defaults',
}));

// --- Imports (after all mock.module calls) ---
import { executeDagWorkflow } from './dag-executor';
import type { ScriptNode, WorkflowRun } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';

// --- Helpers ---

function createMockStore(): IWorkflowStore {
  return {
    createWorkflowRun: mock(() =>
      Promise.resolve({
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
      })
    ),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    failOrphanedRuns: mock(() => Promise.resolve({ count: 0 })),
    findResumableRun: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() =>
      Promise.resolve({
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
      })
    ),
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
  yield { type: 'assistant', content: 'AI response' };
  yield { type: 'result', sessionId: 'session-id' };
});

const mockGetAgentProvider = mock(() => ({
  sendQuery: mockSendQuery,
  getType: () => 'claude',
}));

function createMockDeps(): WorkflowDeps {
  return {
    store: createMockStore(),
    getAgentProvider: mockGetAgentProvider,
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

function makeWorkflowRun(id: string): WorkflowRun {
  return {
    id,
    workflow_name: 'deps-test',
    conversation_id: 'conv-deps',
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

describe('script node deps field — command construction', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `script-deps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockExecFileAsync.mockClear();
    mockSendQuery.mockClear();
    mockGetAgentProvider.mockClear();
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('uv inline with deps uses uv run --with flags', async () => {
    const node: ScriptNode = {
      id: 'fetch-data',
      script: 'import httpx; print(httpx.get("https://example.com").status_code)',
      runtime: 'uv',
      deps: ['httpx', 'beautifulsoup4'],
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-1'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args[0]).toBe('run');
    expect(args).toContain('--with');
    expect(args).toContain('httpx');
    expect(args).toContain('beautifulsoup4');
    expect(args).toContain('python');
    expect(args).toContain('-c');
    // run --with httpx --with beautifulsoup4 python -c <code>
    expect(args.indexOf('--with')).toBeLessThan(args.indexOf('python'));
    expect(args[args.indexOf('python') + 1]).toBe('-c');
  });

  it('uv inline without deps uses uv run python -c', async () => {
    const node: ScriptNode = {
      id: 'simple-py',
      script: 'print("hello")',
      runtime: 'uv',
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-2'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args).toEqual(['run', 'python', '-c', 'print("hello")']);
  });

  it('uv inline with empty deps array uses uv run python -c (no extra flags)', async () => {
    const node: ScriptNode = {
      id: 'empty-deps-py',
      script: 'print("no deps")',
      runtime: 'uv',
      deps: [],
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-3'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args).toEqual(['run', 'python', '-c', 'print("no deps")']);
  });

  it('bun inline with deps uses bun --no-env-file -e (no extra dep flags — bun auto-installs)', async () => {
    const node: ScriptNode = {
      id: 'bun-with-deps',
      script: 'import { z } from "zod"; console.log(z.string().parse("hello"))',
      runtime: 'bun',
      deps: ['zod', 'node-fetch'],
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-4'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'bun');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('bun');
    // --no-env-file prevents repo .env auto-load; no dep flags — bun auto-installs
    expect(args).toEqual(['--no-env-file', '-e', node.script]);
    expect(args).not.toContain('--packages');
    expect(args).not.toContain('--with');
  });

  it('bun inline without deps uses bun --no-env-file -e', async () => {
    const node: ScriptNode = {
      id: 'bun-no-deps',
      script: 'console.log("hello")',
      runtime: 'bun',
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-5'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'bun');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('bun');
    expect(args).toEqual(['--no-env-file', '-e', 'console.log("hello")']);
  });

  it('uv named script with deps uses uv run --with flags', async () => {
    // Create a named Python script
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    const { writeFile } = await import('fs/promises');
    await writeFile(join(scriptsDir, 'analyze.py'), 'import httpx\nprint("ok")');

    const node: ScriptNode = {
      id: 'run-analyze',
      script: 'analyze',
      runtime: 'uv',
      deps: ['httpx'],
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-6'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args[0]).toBe('run');
    expect(args).toContain('--with');
    expect(args).toContain('httpx');
    // --with httpx comes before the file path
    const withIdx = args.indexOf('--with');
    const httpxIdx = args.indexOf('httpx');
    expect(httpxIdx).toBe(withIdx + 1);
    // Last arg is the script path
    expect(args[args.length - 1]).toContain('analyze.py');
  });

  it('uv named script without deps uses uv run <path> (no --with flags)', async () => {
    // Create a named Python script
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    const { writeFile } = await import('fs/promises');
    await writeFile(join(scriptsDir, 'simple.py'), 'print("simple")');

    const node: ScriptNode = {
      id: 'run-simple',
      script: 'simple',
      runtime: 'uv',
    };

    await executeDagWorkflow(
      createMockDeps(),
      createMockPlatform(),
      'conv-deps',
      testDir,
      { name: 'deps-test', nodes: [node] },
      makeWorkflowRun('deps-run-7'),
      'claude',
      undefined,
      join(testDir, 'artifacts'),
      join(testDir, 'logs'),
      'main',
      'docs/',
      minimalConfig
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args).not.toContain('--with');
    // uv run <path>
    expect(args[0]).toBe('run');
    expect(args[args.length - 1]).toContain('simple.py');
  });
});
