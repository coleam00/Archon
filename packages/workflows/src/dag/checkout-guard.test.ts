// @archon-test-isolated
import { describe, mock, beforeEach, afterEach, it, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir } from 'fs/promises';
import * as git from '@archon/git';
import { removeTempTree } from '@archon/paths/test-utils';
import type { ExecNode, DagNode } from '../schemas';
import { executeDagWorkflow } from '../dag-executor';
import type { PersistedNodeOutput } from '../store';
import {
  createMockDeps,
  createMockPlatform,
  makeWorkflowRun,
  dagOptions,
  mockSendQueryDag,
  mockGetAgentProviderDag,
  mockClaudeCapabilities,
} from './test-utils';

// ---------------------------------------------------------------------------
// mutates_checkout: false — per-node tree-integrity assertion (#2771)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- node-level mutates_checkout: false (#2771)', () => {
  let testDir: string;

  // Three git processes, not five: the identity travels as `-c` overrides on the commit
  // rather than as two separate `git config` writes. Six tests here pay this cost, and
  // process creation is the expensive part on Windows CI (#2882).
  const initRepo = async (dir: string): Promise<void> => {
    await git.execFileAsync('git', ['init', '-q'], { cwd: dir });
    await git.execFileAsync('git', ['add', '-A'], { cwd: dir });
    await git.execFileAsync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'],
      { cwd: dir }
    );
  };

  const runBashNode = async (
    script: string,
    declareReadOnly: boolean
  ): Promise<ReturnType<typeof createMockDeps>> => {
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('mc-run-id', {
      workflow_name: 'mc-test',
      conversation_id: 'conv-mc',
      user_message: 'mc test',
    });
    const bashNode: ExecNode = {
      id: 'guarded',
      kind: 'exec',
      runtime: 'sh',
      script,
      ...(declareReadOnly ? { mutates_checkout: false as const } : {}),
    };
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-mc',
        cwd: testDir,
        workflow: { name: 'mc-test', nodes: [bashNode] },
        workflowRun,
      })
    );
    return mockDeps;
  };

  const nodeFailedError = (
    deps: ReturnType<typeof createMockDeps>,
    nodeId: string
  ): string | undefined => {
    const calls = (deps.store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls as Array<
      [{ event_type: string; step_name?: string; data?: { error?: string } }]
    >;
    const failed = calls.find(([e]) => e.event_type === 'node_failed' && e.step_name === nodeId);
    return failed?.[0].data?.error;
  };

  beforeEach(async () => {
    testDir = join(tmpdir(), `dag-mc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });

    mockSendQueryDag.mockClear();
    mockGetAgentProviderDag.mockClear();

    mockSendQueryDag.mockImplementation(async function* () {
      yield { type: 'agent_message_chunk', text: 'DAG AI response' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });

    mockGetAgentProviderDag.mockImplementation(() => ({
      sendQuery: mockSendQueryDag,
      checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
      getType: () => 'claude',
      getCapabilities: mockClaudeCapabilities,
    }));
  });

  afterEach(async () => {
    await removeTempTree(testDir);
  });

  it('a clean read-only node succeeds', async () => {
    await initRepo(testDir);
    const deps = await runBashNode('echo untouched', true);
    expect(nodeFailedError(deps, 'guarded')).toBeUndefined();
  });

  it('a read-only node that writes to the tree fails naming the node and path', async () => {
    await initRepo(testDir);
    const deps = await runBashNode('touch stray.txt', true);
    const error = nodeFailedError(deps, 'guarded');
    expect(error).toBeDefined();
    expect(error).toContain('guarded');
    expect(error).toContain('mutates_checkout: false');
    expect(error).toContain('stray.txt');
  });

  it('an undeclared mutating node is not checked', async () => {
    await initRepo(testDir);
    const deps = await runBashNode('touch stray.txt', false);
    expect(nodeFailedError(deps, 'guarded')).toBeUndefined();
  });

  it('writes under the engine-owned artifacts dir do not trip the assertion', async () => {
    await initRepo(testDir);
    // executeBashNode injects ARTIFACTS_DIR into the script's environment.
    const deps = await runBashNode(
      'mkdir -p "$ARTIFACTS_DIR" && echo x > "$ARTIFACTS_DIR/out.txt"',
      true
    );
    expect(nodeFailedError(deps, 'guarded')).toBeUndefined();
  });

  it('a write to a sibling that only shares the artifacts dir name prefix still trips it', async () => {
    await initRepo(testDir);
    const deps = await runBashNode(
      'mkdir -p "${ARTIFACTS_DIR}-old" && echo x > "${ARTIFACTS_DIR}-old/out.txt"',
      true
    );
    const error = nodeFailedError(deps, 'guarded');
    expect(error).toContain('mutates_checkout: false');
    expect(error).toContain('artifacts-old');
  });

  it('outside a git repo the check fails open and the node succeeds', async () => {
    const deps = await runBashNode('touch stray.txt', true);
    expect(nodeFailedError(deps, 'guarded')).toBeUndefined();
  });

  it('a mutating sibling in the same layer is not attributed to a guarded node', async () => {
    await initRepo(testDir);
    const mockDeps = createMockDeps();
    const platform = createMockPlatform();
    const workflowRun = makeWorkflowRun('mc-run-id', {
      workflow_name: 'mc-test',
      conversation_id: 'conv-mc',
      user_message: 'mc test',
    });
    const nodes: ExecNode[] = [
      {
        id: 'guarded',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo read-only',
        mutates_checkout: false as const,
      },
      { id: 'mutator', kind: 'exec', runtime: 'sh', script: 'touch sibling.txt' },
    ];
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform,
        conversationId: 'conv-mc',
        cwd: testDir,
        workflow: { name: 'mc-test', nodes },
        workflowRun,
      })
    );
    expect(nodeFailedError(mockDeps, 'guarded')).toBeUndefined();
  });

  const runGuardedLayer = async (
    scripts: Record<string, string>,
    priorCompletedNodes?: Map<string, PersistedNodeOutput>
  ): Promise<ReturnType<typeof createMockDeps>> => {
    const mockDeps = createMockDeps();
    const workflowRun = makeWorkflowRun('mc-run-id', {
      workflow_name: 'mc-test',
      conversation_id: 'conv-mc',
      user_message: 'mc test',
    });
    const nodes: ExecNode[] = Object.entries(scripts).map(([id, script]) => ({
      id,
      kind: 'exec',
      runtime: 'sh',
      script,
      mutates_checkout: false as const,
    }));
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform: createMockPlatform(),
        conversationId: 'conv-mc',
        cwd: testDir,
        workflow: { name: 'mc-test', nodes },
        workflowRun,
        priorCompletedNodes,
      })
    );
    return mockDeps;
  };

  it('a layer of guarded nodes only runs its nodes concurrently', async () => {
    await initRepo(testDir);
    // Each node marks itself started, then waits for the other's mark. Run one after
    // the other, the first never sees the second's mark and fails at the bound.
    const meetThenExit = (self: string, other: string): string =>
      `mkdir -p "$ARTIFACTS_DIR" && touch "$ARTIFACTS_DIR/${self}" && i=0; ` +
      `while [ ! -f "$ARTIFACTS_DIR/${other}" ]; do i=$((i+1)); ` +
      `[ $i -gt 40 ] && exit 1; sleep 0.1; done`;
    const deps = await runGuardedLayer({
      first: meetThenExit('first', 'second'),
      second: meetThenExit('second', 'first'),
    });
    expect(nodeFailedError(deps, 'first')).toBeUndefined();
    expect(nodeFailedError(deps, 'second')).toBeUndefined();
  });

  it('a write in a concurrent guarded layer fails every guarded node whose window it landed in', async () => {
    await initRepo(testDir);
    // The writer writes only after the reader has started, and the reader exits only
    // after the write, so the write lands inside both nodes' windows.
    const deps = await runGuardedLayer({
      writer:
        'i=0; while [ ! -f "$ARTIFACTS_DIR/reader" ]; do i=$((i+1)); ' +
        '[ $i -gt 40 ] && exit 1; sleep 0.1; done; touch stray.txt',
      reader:
        'mkdir -p "$ARTIFACTS_DIR" && touch "$ARTIFACTS_DIR/reader" && i=0; ' +
        'while [ ! -f stray.txt ]; do i=$((i+1)); [ $i -gt 40 ] && exit 1; sleep 0.1; done',
    });
    const writerError = nodeFailedError(deps, 'writer');
    expect(writerError).toContain('stray.txt');
    expect(writerError).toContain('guarded siblings `reader`');
    expect(writerError).toContain("may not be this node's alone");
    // The innocent reader fails too: one repo-wide snapshot cannot tell whose write it saw.
    const readerError = nodeFailedError(deps, 'reader');
    expect(readerError).toContain('stray.txt');
    expect(readerError).toContain('guarded siblings `writer`');
  });

  it('a loop declaring mutates_checkout: false still serializes its layer', async () => {
    await initRepo(testDir);
    const mockDeps = createMockDeps();
    // The guarded node waits briefly for the loop's write. Run concurrently, the write
    // lands inside its window and fails it; run one after the other, it never sees it.
    const nodes: DagNode[] = [
      {
        id: 'guarded',
        kind: 'exec',
        runtime: 'sh',
        script:
          'i=0; while [ ! -f loop.txt ]; do i=$((i+1)); [ $i -gt 10 ] && exit 0; sleep 0.1; done',
        mutates_checkout: false,
      },
      {
        id: 'looper',
        kind: 'loop',
        mutates_checkout: false,
        loop: {
          fresh_context: false,
          prompt: 'Do a task.',
          until_bash: 'touch loop.txt',
          max_iterations: 1,
        },
      },
    ];
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform: createMockPlatform(),
        conversationId: 'conv-mc',
        cwd: testDir,
        workflow: { name: 'mc-test', nodes },
        workflowRun: makeWorkflowRun('mc-run-id', {
          workflow_name: 'mc-test',
          conversation_id: 'conv-mc',
          user_message: 'mc test',
        }),
      })
    );
    expect(nodeFailedError(mockDeps, 'guarded')).toBeUndefined();
    expect(nodeFailedError(mockDeps, 'looper')).toBeUndefined();
  });

  it('a violation names no guarded node from an earlier layer', async () => {
    await initRepo(testDir);
    const mockDeps = createMockDeps();
    const guarded = (id: string, script: string, depends_on?: string[]): ExecNode => ({
      id,
      kind: 'exec',
      runtime: 'sh',
      script,
      mutates_checkout: false as const,
      ...(depends_on ? { depends_on } : {}),
    });
    await executeDagWorkflow(
      dagOptions({
        deps: mockDeps,
        platform: createMockPlatform(),
        conversationId: 'conv-mc',
        cwd: testDir,
        workflow: {
          name: 'mc-test',
          nodes: [
            guarded('first', 'echo a'),
            guarded('second', 'echo b'),
            guarded('writer', 'touch stray.txt', ['first', 'second']),
          ],
        },
        workflowRun: makeWorkflowRun('mc-run-id', {
          workflow_name: 'mc-test',
          conversation_id: 'conv-mc',
          user_message: 'mc test',
        }),
      })
    );
    const error = nodeFailedError(mockDeps, 'writer');
    expect(error).toContain('stray.txt');
    expect(error).not.toContain('first');
    expect(error).not.toContain('second');
  });

  it('a violation on resume names no sibling reused from the prior run', async () => {
    await initRepo(testDir);
    const deps = await runGuardedLayer(
      { writer: 'touch stray.txt', cachedA: 'echo a', cachedB: 'echo b' },
      new Map([
        ['cachedA', { output: 'a' }],
        ['cachedB', { output: 'b' }],
      ])
    );
    const error = nodeFailedError(deps, 'writer');
    expect(error).toContain('stray.txt');
    expect(error).not.toContain('cachedA');
    expect(error).not.toContain('cachedB');
  });

  it('non-ASCII paths under excluded dirs do not trip the assertion', async () => {
    await initRepo(testDir);
    const deps = await runBashNode(
      'mkdir -p "$ARTIFACTS_DIR/日本語" && echo x > "$ARTIFACTS_DIR/日本語/out.txt"',
      true
    );
    expect(nodeFailedError(deps, 'guarded')).toBeUndefined();
  });
});
