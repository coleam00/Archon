// @archon-test-isolated
import { describe, mock, beforeEach, afterEach, it, expect, spyOn } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdir, writeFile, readFile, rm, symlink } from 'fs/promises';
import * as fsPromises from 'node:fs/promises';
import { snapshotCheckout, checkoutSnapshotExcludes } from './checkout-guard';
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
  mockLogFn,
} from './test-utils';

// ---------------------------------------------------------------------------
// mutates_checkout: false — per-node tree-integrity assertion (#2771)
// ---------------------------------------------------------------------------

describe('executeDagWorkflow -- node-level mutates_checkout: false (#2771)', () => {
  let testDir: string;

  // Three git processes, not five: the identity travels as `-c` overrides on the commit
  // rather than as two separate `git config` writes. These tests pay this cost, and
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
    declareReadOnly: boolean,
    retry?: ExecNode['retry']
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
      retry,
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
    mockLogFn.mockClear();

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

  it('detects a same-size edit to an already-dirty tracked file', async () => {
    await writeFile(join(testDir, 'tracked.txt'), 'clean');
    await initRepo(testDir);
    await writeFile(join(testDir, 'tracked.txt'), 'dirty');
    const deps = await runBashNode('printf other > tracked.txt', true);
    expect(nodeFailedError(deps, 'guarded')).toContain('mutates_checkout: false');
    expect(nodeFailedError(deps, 'guarded')).toContain('tracked.txt');
  });

  it('detects a new file inside an already-untracked directory', async () => {
    await initRepo(testDir);
    await mkdir(join(testDir, 'untracked'));
    await writeFile(join(testDir, 'untracked', 'before.txt'), 'before');
    const deps = await runBashNode('touch untracked/after.txt', true);
    expect(nodeFailedError(deps, 'guarded')).toContain('mutates_checkout: false');
    expect(nodeFailedError(deps, 'guarded')).toContain('untracked/after.txt');
  });

  it('detects a guarded agent editing an already-dirty tracked file', async () => {
    await writeFile(join(testDir, 'tracked.txt'), 'clean');
    await initRepo(testDir);
    await writeFile(join(testDir, 'tracked.txt'), 'dirty');
    mockSendQueryDag.mockImplementation(async function* () {
      await writeFile(join(testDir, 'tracked.txt'), 'other');
      yield { type: 'agent_message_chunk', text: 'Review complete.' };
      yield { type: 'result', sessionId: 'dag-session-id' };
    });
    const deps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps,
        platform: createMockPlatform(),
        conversationId: 'conv-mc',
        workflowRun: makeWorkflowRun('mc-run-id'),
        cwd: testDir,
        workflow: {
          name: 'guarded-agent',
          nodes: [
            {
              id: 'guarded',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Review the checkout.' },
              mutates_checkout: false,
            },
          ],
        },
      })
    );
    expect(mockSendQueryDag).toHaveBeenCalledTimes(1);
    expect(nodeFailedError(deps, 'guarded')).toContain('mutates_checkout: false');
    expect(nodeFailedError(deps, 'guarded')).toContain('tracked.txt');
  });

  it('accepts an unchanged dirty checkout', async () => {
    await writeFile(join(testDir, 'tracked.txt'), 'clean');
    await initRepo(testDir);
    await writeFile(join(testDir, 'tracked.txt'), 'dirty');
    expect(nodeFailedError(await runBashNode('echo untouched', true), 'guarded')).toBeUndefined();
  });

  it('names a dirty path removed from status', async () => {
    await initRepo(testDir);
    await writeFile(join(testDir, 'removed.txt'), 'dirty');
    expect(nodeFailedError(await runBashNode('rm removed.txt', true), 'guarded')).toContain(
      'removed.txt'
    );
  });

  it('does not retry a checkout violation', async () => {
    await initRepo(testDir);
    const deps = await runBashNode(
      'mkdir -p "$ARTIFACTS_DIR" && echo attempt >> "$ARTIFACTS_DIR/attempts" && touch stray.txt',
      true,
      { max_attempts: 3, delay_ms: 1, on_error: 'all' }
    );
    expect(await readFile(join(testDir, 'artifacts', 'attempts'), 'utf8')).toBe('attempt\n');
    expect(deps.store.createWorkflowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'node_failed',
        data: expect.objectContaining({ failure_kind: 'output_contract' }),
      })
    );
  });

  it('fingerprints edits to an already-untracked file', async () => {
    await initRepo(testDir);
    const path = join(testDir, 'untracked.txt');
    await writeFile(path, 'before');
    const before = await snapshotCheckout(testDir, []);
    await writeFile(path, 'after!');
    const after = await snapshotCheckout(testDir, []);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after?.get('untracked.txt')).not.toEqual(before?.get('untracked.txt'));
  });

  it.each(['artifacts', 'state', 'logs'])(
    'excludes %s in a mixed untracked parent from a nested cwd',
    async root => {
      await initRepo(testDir);
      const parent = join(testDir, 'untracked');
      const engineRoot = join(parent, root);
      await mkdir(engineRoot, { recursive: true });
      await writeFile(join(engineRoot, 'output'), 'before');
      await writeFile(join(parent, 'user.txt'), 'before');
      const excludes = checkoutSnapshotExcludes(
        join(parent, 'artifacts'),
        join(parent, 'state'),
        join(parent, 'logs')
      );
      const before = await snapshotCheckout(parent, excludes);
      expect([...(before?.keys() ?? [])]).toEqual(['untracked/user.txt']);
      await writeFile(join(engineRoot, 'output'), 'after');
      expect(await snapshotCheckout(parent, excludes)).toEqual(before);
      await writeFile(join(parent, 'user.txt'), 'after');
      expect(await snapshotCheckout(parent, excludes)).not.toEqual(before);
    }
  );

  it('preserves literal filenames and consumes NUL rename source records', async () => {
    const source = 'old - 日本語.txt';
    const destination = 'new - 日本語.txt';
    await writeFile(join(testDir, source), 'content');
    await initRepo(testDir);
    await git.execFileAsync('git', ['mv', source, destination], { cwd: testDir });
    await writeFile(join(testDir, destination), 'dirty!!');
    const names =
      process.platform === 'win32'
        ? ['unicode-å.txt']
        : ['arrow ->.txt', 'tab\t.txt', 'line\n.txt'];
    for (const name of names) await writeFile(join(testDir, name), name);
    const before = await snapshotCheckout(testDir, []);
    expect(before).toBeDefined();
    expect([...(before?.keys() ?? [])].sort()).toEqual([source, destination, ...names].sort());
    expect(before?.get(source)?.content.kind).toBe('missing');
    await writeFile(join(testDir, destination), 'changed');
    const after = await snapshotCheckout(testDir, []);
    expect(after?.get(destination)).not.toEqual(before?.get(destination));
    expect(after?.get(source)).toEqual(before?.get(source));
  });

  it('resolves dirty tracked files from a nested cwd', async () => {
    await writeFile(join(testDir, 'tracked.txt'), 'clean');
    await mkdir(join(testDir, 'nested'));
    await initRepo(testDir);
    await writeFile(join(testDir, 'tracked.txt'), 'dirty');
    const before = await snapshotCheckout(join(testDir, 'nested'), []);
    expect(before).toEqual(await snapshotCheckout(testDir, []));
    expect(before?.get('tracked.txt')?.content.kind).toBe('file');
    await writeFile(join(testDir, 'tracked.txt'), 'other');
    expect(await snapshotCheckout(join(testDir, 'nested'), [])).not.toEqual(before);
  });

  it('keeps the visible endpoint of a rename into an excluded directory', async () => {
    await writeFile(join(testDir, 'visible.txt'), 'content');
    await initRepo(testDir);
    const excluded = join(testDir, 'engine');
    await mkdir(excluded);
    await git.execFileAsync('git', ['mv', 'visible.txt', 'engine/moved.txt'], { cwd: testDir });
    expect([...((await snapshotCheckout(testDir, [excluded]))?.keys() ?? [])]).toEqual([
      'visible.txt',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'fingerprints dangling symlinks without following them',
    async () => {
      await initRepo(testDir);
      const link = join(testDir, 'link');
      await symlink('missing-one', link);
      const before = await snapshotCheckout(testDir, []);
      expect(before?.get('link')?.content).toEqual({ kind: 'symlink', value: 'missing-one' });
      await rm(link);
      await symlink('missing-two', link);
      expect(await snapshotCheckout(testDir, [])).not.toEqual(before);
    }
  );

  it('returns unavailable on Git failure', async () => {
    const error = new git.GitFailure('unclassified', 'failed');
    const exec = spyOn(git, 'execFileAsync').mockRejectedValue(error);
    try {
      expect(await snapshotCheckout(testDir, [])).toBeUndefined();
      expect(mockLogFn).toHaveBeenCalledWith(
        { cwd: testDir, err: error },
        'dag_checkout_snapshot_unavailable'
      );
    } finally {
      exec.mockRestore();
    }
  });

  it.each(['before', 'after'])(
    'skips the assertion when the %s status exceeds the subprocess output buffer',
    async phase => {
      await initRepo(testDir);
      const execFile = git.execFileAsync;
      let statusCalls = 0;
      const exec = spyOn(git, 'execFileAsync').mockImplementation(async (cmd, args, options) => {
        if (cmd === 'git' && args[0] === 'status') {
          statusCalls++;
          if (statusCalls === (phase === 'before' ? 1 : 2)) {
            expect(options?.maxBuffer).toBeUndefined();
            const cause = Object.assign(new Error('stdout maxBuffer length exceeded'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            });
            throw new git.GitFailure('unclassified', cause.message, cause);
          }
        }
        return execFile(cmd, args, options);
      });
      try {
        const deps = await runBashNode('touch stray.txt', true);
        expect(statusCalls).toBe(phase === 'before' ? 1 : 2);
        expect(await readFile(join(testDir, 'stray.txt'), 'utf8')).toBe('');
        expect(nodeFailedError(deps, 'guarded')).toBeUndefined();
        expect(deps.store.createWorkflowEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_type: 'node_completed', step_name: 'guarded' })
        );
        expect(deps.store.completeWorkflowRun).toHaveBeenCalled();
        expect(mockLogFn).toHaveBeenCalledWith(
          {
            cwd: testDir,
            err: expect.objectContaining({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
          },
          'dag_checkout_snapshot_unavailable'
        );
      } finally {
        exec.mockRestore();
      }
    }
  );

  it('the Git subprocess boundary rejects output above its default 1 MiB limit', async () => {
    const config = join(testDir, 'buffer-test.config');
    const args = ['config', '--file', config, '--get', 'buffer.value'];
    await writeFile(config, `[buffer]\nvalue = ${'x'.repeat(1024 * 1024 - 2)}\n`);
    expect((await git.execFileAsync('git', args)).stdout.length).toBe(1024 * 1024 - 1);
    await writeFile(config, `[buffer]\nvalue = ${'x'.repeat(1024 * 1024)}\n`);
    await expect(git.execFileAsync('git', args)).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
  });

  it('discards a partial snapshot on filesystem failure', async () => {
    await initRepo(testDir);
    await writeFile(join(testDir, 'first'), 'one');
    await writeFile(join(testDir, 'second'), 'two');
    const stat = spyOn(fsPromises, 'lstat');
    stat.mockResolvedValueOnce(await fsPromises.stat(join(testDir, 'first')));
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    stat.mockRejectedValueOnce(error);
    try {
      expect(await snapshotCheckout(testDir, [])).toBeUndefined();
      expect(stat).toHaveBeenCalledTimes(2);
      expect(mockLogFn).toHaveBeenCalledWith(
        { cwd: testDir, err: error },
        'dag_checkout_snapshot_unavailable'
      );
    } finally {
      stat.mockRestore();
    }
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
