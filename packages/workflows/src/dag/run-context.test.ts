// @archon-test-isolated
import { readNodeRecordEvent } from '../node-record-reader';
import { describe, it, expect, beforeEach, afterEach, type Mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import * as git from '@archon/git';
import { createMockDeps, dagOptions, makeWorkflowRun } from './test-utils';
import { executeDagWorkflow } from '../dag-executor';
import type { DagNode } from '../schemas';
import type { IWorkflowStore } from '../store';

describe('executeDagWorkflow -- node checkout starts (#3375)', () => {
  let root: string;
  let repoDir: string;

  beforeEach(async () => {
    root = join(tmpdir(), `dag-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    repoDir = join(root, 'repo');
    await mkdir(repoDir, { recursive: true });
    await git.execFileAsync('git', ['init', '-q'], { cwd: repoDir });
    await git.execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: repoDir });
    await git.execFileAsync('git', ['config', 'user.name', 't'], { cwd: repoDir });
    await writeFile(join(repoDir, 'a.txt'), 'a\n');
    await git.execFileAsync('git', ['add', '-A'], { cwd: repoDir });
    await git.execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repoDir });
  });

  afterEach(async () => {
    await removeTempTree(root);
  });

  const head = async (): Promise<string> =>
    (await git.execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

  const run = async (nodes: DagNode[]): Promise<ReturnType<typeof createMockDeps>> => {
    const deps = createMockDeps();
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: repoDir,
        // Run artifacts live outside the checkout, as they do in a real run.
        artifactsDir: join(root, 'artifacts'),
        stateDir: join(root, 'state'),
        logDir: join(root, 'logs'),
        workflow: { name: 'checkout-starts', nodes },
        workflowRun: makeWorkflowRun('checkout-run'),
      })
    );
    return deps;
  };

  const terminal = (
    deps: ReturnType<typeof createMockDeps>,
    stepName: string
  ): NonNullable<ReturnType<typeof readNodeRecordEvent>>[] =>
    (deps.store.persistWorkflowEvent as Mock<IWorkflowStore['persistWorkflowEvent']>).mock.calls
      .map(([event]) => event)
      .filter(
        event =>
          event.step_name === stepName &&
          (event.event_type === 'node_completed' || event.event_type === 'node_failed')
      )
      .map(event => {
        const record = readNodeRecordEvent({
          ...event,
          step_name: event.step_name ?? null,
          data: event.data ?? {},
        });
        if (!record) throw new Error(`unreadable ${event.event_type} for ${stepName}`);
        return record;
      });

  it('a node records the checkout it started at, even after an earlier node moved it', async () => {
    const initial = await head();
    const deps = await run([
      {
        id: 'commit',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo b > b.txt && git add b.txt && git commit -qm b',
      },
      { id: 'after', kind: 'exec', runtime: 'sh', script: 'true', depends_on: ['commit'] },
    ]);
    const moved = await head();
    expect(moved).not.toBe(initial);

    const [commitRecord] = terminal(deps, 'commit');
    const [afterRecord] = terminal(deps, 'after');
    expect(commitRecord?.metadata?.attempt.checkoutStart).toMatchObject({
      kind: 'git',
      commit: initial,
      worktree: { status: 'clean' },
    });
    expect(commitRecord?.metadata?.invocation.checkoutStart).toEqual(
      commitRecord?.metadata?.attempt.checkoutStart
    );
    expect(afterRecord?.metadata?.attempt.checkoutStart).toMatchObject({
      kind: 'git',
      commit: moved,
    });
  });

  it('a retry samples its own attempt start while the invocation keeps the first', async () => {
    const deps = await run([
      {
        id: 'flaky',
        kind: 'exec',
        runtime: 'sh',
        // First attempt leaves an untracked file behind and fails; the retry succeeds.
        script: 'if [ -f marker ]; then exit 0; fi; touch marker; exit 1',
        retry: { max_attempts: 1, delay_ms: 1, on_error: 'all' },
      },
    ]);
    const [failed, completed] = terminal(deps, 'flaky');
    expect(failed?.eventType).toBe('node_failed');
    expect(completed?.eventType).toBe('node_completed');
    expect(completed?.metadata?.invocation).toEqual(failed?.metadata?.invocation);
    expect(completed?.metadata?.invocation.checkoutStart).toMatchObject({
      worktree: { status: 'clean' },
    });
    expect(completed?.metadata?.attempt.checkoutStart).toMatchObject({
      worktree: { status: 'dirty', untracked: 1 },
    });
  });

  it('binds a producer invocation start and hands a script its own execution record', async () => {
    const deps = await run([
      { id: 'producer', kind: 'exec', runtime: 'sh', script: 'echo dirty > a.txt' },
      {
        id: 'consumer',
        kind: 'exec',
        runtime: 'bun',
        depends_on: ['producer'],
        with: { start: '$producer.execution.checkoutStart' },
        script:
          'console.log(process.env.INPUTS_START); console.log(process.env.ARCHON_NODE_EXECUTION);',
      },
    ]);
    const [producer] = terminal(deps, 'producer');
    const [consumer] = terminal(deps, 'consumer');
    const [bound, own] = (consumer?.data.node_output ?? '').split('\n');
    expect(JSON.parse(bound ?? '')).toEqual(producer?.metadata?.invocation.checkoutStart);
    const execution = JSON.parse(own ?? '') as {
      runId: string;
      attempt: { checkoutStart: unknown };
    };
    expect(execution.runId).toBe('checkout-run');
    expect(execution.attempt.checkoutStart).toEqual(consumer?.metadata?.attempt.checkoutStart);
    expect(execution.attempt.checkoutStart).toMatchObject({ worktree: { status: 'dirty' } });
  });

  it('fails a binding whose producer records no checkout start', async () => {
    const deps = await run([
      { id: 'gate', kind: 'exec', runtime: 'sh', script: 'true' },
      {
        id: 'consumer',
        kind: 'exec',
        runtime: 'bun',
        depends_on: ['gate'],
        with: { start: '$gate.execution.checkoutStart', other: '$missing.execution.checkoutStart' },
        script: 'console.log(process.env.INPUTS_START, process.env.INPUTS_OTHER);',
      },
    ]);
    const [consumer] = terminal(deps, 'consumer');
    expect(consumer?.eventType).toBe('node_failed');
    expect(consumer?.data.error).toContain('$missing.execution.checkoutStart');
  });
});
