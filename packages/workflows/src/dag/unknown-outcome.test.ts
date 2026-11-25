// @archon-test-isolated
/**
 * A failure that reaches the run's top level while the run holds a node whose outcome is
 * unknown ends the run at once, with stop reason `outcome_unknown`. No built-in node records
 * the kind yet, so these tests have the engine's own `recordNodeState` record it for the
 * named nodes; everything past that write (retry, persistence, aggregates, the walk, the
 * store's transitions) runs as for a real producer, against a real file store.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as nodeEventWrite from '../node-event-write';
import { executeDagWorkflow } from '../dag-executor';
import { createFileWorkflowStore } from '../file-store/store';
import { hydrateResumableRun } from '../run-resume';
import { stoppedItems } from '../queue-items-without-run';
import { captureWorkflowSource, capturedSourceRoots } from '../workflow-source';
import { WorkflowSourceUnavailableError } from '../workflow-source';
import * as sourceLoader from '../workflow-source/load';
import { pendingWorkflowWaitDeadline, type DagNode, type WorkflowRun } from '../schemas';
import { WorkflowNotResumableError, deadlineWaitCursor } from '../store';
import type { WorkflowDeps } from '../deps';
import type { IWorkflowStore } from '../store';
import {
  createMockDeps,
  dagOptions,
  minimalConfig,
  mockClaudeCapabilities,
  mockGetAgentProviderDag,
  stubMissingContainer,
} from './test-utils';

const roots = trackTempRoots();
const realRecordNodeState = nodeEventWrite.recordNodeState;

/**
 * Record a failure of each named node as `outcome_unknown`, as a writing tool would; with
 * `once`, only the first such failure.
 */
function failingWithOutcomeUnknown(nodeIds: readonly string[], { once = false } = {}) {
  let marked = false;
  return spyOn(nodeEventWrite, 'recordNodeState').mockImplementation(
    (sinks, record, continuation) => {
      if (
        'cache' in record ||
        record.lifecycle.status !== 'failed' ||
        (once && marked) ||
        // A composed instance's inner node carries the instance prefix.
        !nodeIds.some(id => record.node.id === id || record.node.id.endsWith(`__${id}`))
      )
        return realRecordNodeState(sinks, record, continuation);
      marked = true;
      const lifecycle = { ...record.lifecycle, failureKind: 'outcome_unknown' as const };
      return realRecordNodeState(sinks, { ...record, lifecycle }, continuation);
    }
  );
}

/** A contract failure: stdout that is not the declared JSON, so `retryable: false`. */
const contractFailure = { script: "echo 'not json'", output_format: { type: 'object' } };

describe('a failure whose outcome is unknown', () => {
  let testDir: string;
  let spy: ReturnType<typeof failingWithOutcomeUnknown> | undefined;

  beforeEach(async () => {
    testDir = roots(await mkdtemp(join(tmpdir(), 'unknown-outcome-')));
  });

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
  });

  /** Run `nodes` once on a fresh file store and return the store and the run id. */
  async function run(
    name: string,
    nodes: DagNode[],
    options: Partial<Parameters<typeof dagOptions>[0]> & {
      budget?: { max_work_units: number };
      prepare?: (store: IWorkflowStore) => void;
    } = {}
  ): Promise<{ store: IWorkflowStore; runId: string; deps: WorkflowDeps }> {
    const store = await createFileWorkflowStore({ root: join(testDir, 'store') });
    options.prepare?.(store);
    const pending = await store.createWorkflowRun({ workflow_name: name, user_message: '' });
    const workflowRun = await store.claimPendingWorkflowRun(pending.id);
    if (!workflowRun) throw new Error('run was not claimed');
    const deps = { ...createMockDeps(), store };
    const { budget, prepare: _prepare, ...rest } = options;
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow: { name, nodes, ...(budget === undefined ? {} : { budget }) },
        workflowRun,
        ...rest,
      })
    );
    return { store, runId: workflowRun.id, deps };
  }

  async function events(store: IWorkflowStore, runId: string, type: string, step?: string) {
    return (await store.listWorkflowEvents(runId)).filter(
      e => e.event_type === type && (step === undefined || e.step_name === step)
    );
  }

  async function expectEnded(store: IWorkflowStore, runId: string): Promise<void> {
    expect(await store.getWorkflowRun(runId)).toMatchObject({
      status: 'failed',
      metadata: { stop_reason: { reason: 'outcome_unknown' } },
    });
    const due = await store.listDueWorkflowContinuations(new Date(Date.now() + 3_600_000));
    expect(due.map(r => r.id)).not.toContain(runId);
  }

  /** The continuation host's automatic claim of the run's pending timed wait. */
  async function claimWait(store: IWorkflowStore, run: WorkflowRun): Promise<unknown> {
    const wait = pendingWorkflowWaitDeadline(run);
    if (wait === undefined) throw new Error('run is not paused at a timed wait');
    return store.resumeWorkflowRun(run.id, deadlineWaitCursor(wait)).catch((err: unknown) => err);
  }

  it('is not retried under on_error: all, and ends the run with its stop reason', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const { store, runId } = await run('unknown-retry', [
      {
        id: 'write',
        kind: 'exec',
        runtime: 'sh',
        script: 'exit 1',
        retry: { max_attempts: 3, delay_ms: 1, on_error: 'all' },
      } as DagNode,
    ]);
    expect(await events(store, runId, 'node_started', 'write')).toHaveLength(1);
    await expectEnded(store, runId);
  });

  it.each([false, true])(
    'ends a run that a parallel wait already paused, and no continuation is due (always_run: %s)',
    async alwaysRun => {
      spy = failingWithOutcomeUnknown(['write']);
      const { store, runId } = await run('unknown-race', [
        // The wait publishes its pause first; the writer fails after it.
        {
          id: 'write',
          kind: 'exec',
          runtime: 'sh',
          script: 'sleep 0.3; exit 1',
          ...(alwaysRun ? { always_run: true } : {}),
        } as DagNode,
        { id: 'delay', kind: 'wait', wait: { duration_ms: 1 } } as DagNode,
      ]);
      expect(await events(store, runId, 'node_started', 'write')).toHaveLength(1);
      await expectEnded(store, runId);
    }
  );

  it('ends a run that a parallel approval gate already paused', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const { store, runId } = await run('unknown-gate', [
      { id: 'write', kind: 'exec', runtime: 'sh', script: 'sleep 0.3; exit 1' },
      {
        id: 'review',
        kind: 'gate',
        message: 'Review',
        decisions: [{ id: 'approve' }],
        decisionsAuthored: false,
        captureResponse: false,
      },
    ] as DagNode[]);
    const order = (await store.listWorkflowEvents(runId)).map(
      e => `${e.event_type}:${e.step_name}`
    );
    // The gate published its pause before the writer failed.
    expect(order.indexOf('approval_requested:review')).toBeGreaterThan(-1);
    expect(order.indexOf('approval_requested:review')).toBeLessThan(
      order.indexOf('node_failed:write')
    );
    await expectEnded(store, runId);
  });

  it('keeps the record and refuses the claim when the run-failing read fails', async () => {
    // Only the writer's own failure: a record written over it must not read as unknown.
    spy = failingWithOutcomeUnknown(['write'], { once: true });
    let paused: WorkflowRun | undefined;
    let store: IWorkflowStore | undefined;
    await run(
      'unknown-read-fault',
      [
        { id: 'write', kind: 'exec', runtime: 'sh', script: 'sleep 0.3; exit 1' },
        { id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } },
      ] as DagNode[],
      {
        prepare: faulted => {
          store = faulted;
          const read = faulted.listEventsForRuns.bind(faulted);
          spyOn(faulted, 'listEventsForRuns').mockImplementation(async (ids, types) => {
            const current = await faulted.getWorkflowRun(ids[0] ?? '');
            // The settle point's read, once the wait paused the run.
            if (
              paused === undefined &&
              current?.status === 'paused' &&
              types?.includes('fan_out_instances')
            ) {
              paused = current;
              throw new Error('store unavailable');
            }
            return read(ids, types);
          });
        },
      }
    ).catch(() => undefined);
    if (store === undefined || paused === undefined) throw new Error('the read never failed');
    const latest = (await store.listWorkflowEvents(paused.id))
      .filter(e => e.step_name === 'write')
      .at(-1);
    expect(latest).toMatchObject({
      event_type: 'node_failed',
      data: { failure_kind: 'outcome_unknown' },
    });
    expect(await claimWait(store, paused)).toBeInstanceOf(WorkflowNotResumableError);
  });

  it('refuses the automatic claim of a parallel wait, before the run fails and after', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const claims: unknown[] = [];
    let paused: WorkflowRun | undefined;
    const { store, runId } = await run(
      'unknown-claim',
      [
        { id: 'write', kind: 'exec', runtime: 'sh', script: 'sleep 0.3; exit 1' },
        { id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } },
      ] as DagNode[],
      {
        // Between the stored failure and the run's fail: the run is paused at the wait.
        prepare: store => {
          const fail = store.failWorkflowRun.bind(store);
          spyOn(store, 'failWorkflowRun').mockImplementation(async (id, error, options) => {
            const current = await store.getWorkflowRun(id);
            if (options?.exitReason === 'outcome_unknown' && current?.status === 'paused') {
              paused = current;
              claims.push(await claimWait(store, current));
            }
            return fail(id, error, options);
          });
        },
      }
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toBeInstanceOf(WorkflowNotResumableError);
    await expectEnded(store, runId);
    if (paused === undefined) throw new Error('the wait never paused the run');
    expect(await claimWait(store, paused)).toBeInstanceOf(WorkflowNotResumableError);
    expect((await store.getWorkflowRun(runId))?.status).toBe('failed');
  });

  it('does not suspend a container for a pause a sibling staged before the run ended', async () => {
    // Every container call fails: the writer's `docker exec` fails, which is its failure.
    const docker = stubMissingContainer();
    const backend = {
      suspend: mock(async () => undefined),
      prepareSuspend: mock(async () => mock(async () => undefined)),
      finalize: mock(async () => ({ requiresApproval: false })),
      applyChanges: mock(async () => ({ filesApplied: 0, filesDeleted: 0, warnings: [] })),
      discardChanges: mock(async () => undefined),
    };
    spy = failingWithOutcomeUnknown(['write']);
    try {
      const { store, runId } = await run(
        'unknown-container',
        [
          { id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1' },
          { id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } },
        ] as DagNode[],
        {
          execContext: { kind: 'container', containerId: 'cid' },
          containerCtx: { envId: 'env', writeBack: 'approve', backend },
        }
      );
      await expectEnded(store, runId);
      expect(backend.prepareSuspend).not.toHaveBeenCalled();
      expect(backend.suspend).not.toHaveBeenCalled();
    } finally {
      docker.mockRestore();
    }
  });

  it('starts no serialized sibling and no later layer after the failure, always_run included', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const marker = join(testDir, 'cleaned');
    const { store, runId } = await run('unknown-serial', [
      // A checkout-guarded node beside an unguarded one runs the layer one at a time.
      { id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1', mutates_checkout: false },
      { id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } },
      {
        id: 'cleanup',
        kind: 'exec',
        runtime: 'sh',
        script: `touch '${marker}'`,
        depends_on: ['write'],
        trigger_rule: 'all_done',
        always_run: true,
      },
    ] as DagNode[]);
    expect(await events(store, runId, 'node_started', 'delay')).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    await expectEnded(store, runId);
  });

  it('keeps the stop reason over a sibling budget refusal', async () => {
    // A script sibling reserves its work unit after reading its source, so the shell writer
    // takes the only unit and the script is refused.
    await mkdir(join(testDir, '.archon', 'scripts'), { recursive: true });
    await writeFile(join(testDir, '.archon', 'scripts', 'other.ts'), 'console.log("other")');
    spy = failingWithOutcomeUnknown(['write']);
    const { store, runId } = await run(
      'unknown-budget',
      [
        { id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1' },
        { id: 'other', kind: 'exec', runtime: 'bun', script: 'other' },
      ] as DagNode[],
      { budget: { max_work_units: 1 } }
    );
    expect(await events(store, runId, 'node_started', 'other')).toEqual([]);
    await expectEnded(store, runId);
  });

  describe('after a provider usage limit with a reset ahead', () => {
    const quotaRun = async (downstream: Partial<DagNode>) => {
      const resetAt = new Date(Date.now() + 10 * 60_000).toISOString();
      mockGetAgentProviderDag.mockReturnValue({
        sendQuery: mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
          async function* () {
            yield {
              type: 'result',
              isError: true,
              sessionId: 'quota',
              failure: { class: 'quota_exhausted', evidence: 'limit', resetAt },
            };
          }
        ),
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'claude',
        getCapabilities: mockClaudeCapabilities,
      });
      return run(
        'unknown-quota',
        [
          { id: 'sweep', kind: 'agent', source: { kind: 'inline', prompt: 'sweep' } },
          {
            id: 'write',
            kind: 'exec',
            runtime: 'sh',
            script: 'exit 1',
            depends_on: ['sweep'],
            trigger_rule: 'all_done',
            ...downstream,
          },
        ] as DagNode[],
        { config: { ...minimalConfig, workflows: { autoResumeOnQuotaReset: true } } }
      );
    };

    it('ends the run instead of waiting when a downstream node fails this way', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      const { store, runId } = await quotaRun({});
      await expectEnded(store, runId);
    });

    it('still waits when the downstream node is a script contract failure (retryable: false)', async () => {
      const { store, runId } = await quotaRun(contractFailure as Partial<DagNode>);
      expect((await events(store, runId, 'node_failed', 'write'))[0]?.data?.retryable).toBe(false);
      expect(await store.getWorkflowRun(runId)).toMatchObject({
        status: 'paused',
        metadata: { wait: { kind: 'quota' } },
      });
    });
  });

  describe.skipIf(process.platform === 'win32')('when a sibling source is unreadable', () => {
    const unreadableRun = async (write: DagNode) => {
      const scripts = join(testDir, '.archon', 'scripts');
      await mkdir(scripts, { recursive: true });
      await writeFile(join(scripts, 'check.ts'), 'console.log("ran")');
      const capture = await captureWorkflowSource({
        sourceRoot: testDir,
        captureRoot: join(testDir, 'capture'),
      });
      const fault = spyOn(sourceLoader, 'assertWorkflowSourceIntegrity').mockRejectedValue(
        new WorkflowSourceUnavailableError(join(testDir, 'capture'), new Error('read denied'))
      );
      try {
        // Inside a loop body: the writer's record is nested, and the group has not settled
        // when the sibling's source read fails.
        return await run(
          'unknown-source',
          [
            {
              id: 'refine',
              kind: 'loop_group',
              loop_group: {
                until: 'DONE',
                max_iterations: 2,
                nodes: [write, { id: 'check', kind: 'exec', runtime: 'bun', script: 'check' }],
              },
            },
          ] as DagNode[],
          { workflowSourceRoots: capturedSourceRoots(capture.anchor) }
        );
      } finally {
        fault.mockRestore();
      }
    };

    it('ends the run instead of releasing it', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      const { store, runId } = await unreadableRun({
        id: 'write',
        kind: 'exec',
        runtime: 'sh',
        script: 'exit 1',
      } as DagNode);
      expect(await events(store, runId, 'source_released')).toEqual([]);
      await expectEnded(store, runId);
    });

    it('still releases it when the sibling is a script contract failure (retryable: false)', async () => {
      const { store, runId } = await unreadableRun({
        id: 'write',
        kind: 'exec',
        runtime: 'sh',
        ...contractFailure,
      } as DagNode);
      expect((await events(store, runId, 'source_released'))[0]?.data).toMatchObject({
        node_id: 'refine.check',
      });
      expect((await store.getWorkflowRun(runId))?.status).toBe('paused');
    });
  });

  describe('inside a composed fan-out', () => {
    // Item 2's instance fails its output contract; with `unknown`, as an unknown outcome.
    const fanOut = async (
      unknown: boolean,
      join_: 'all_done' | 'all_success',
      later?: Partial<DagNode>,
      upstream?: DagNode
    ) => {
      await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(testDir, '.archon', 'workflows', 'writer.yaml'),
        [
          'name: writer',
          'description: block',
          'mutates_checkout: false',
          'inputs:',
          '  item: { required: true }',
          'nodes:',
          '  - id: write',
          `    bash: "if [ $INPUTS.item = 2 ]; then echo notjson; else echo '{}'; fi"`,
          '    output_format: { type: object }',
        ].join('\n')
      );
      if (unknown) spy = failingWithOutcomeUnknown(['write']);
      const marker = join(testDir, 'later');
      const nodes = [
        ...(upstream === undefined ? [] : [upstream]),
        {
          id: 'fan',
          kind: 'compose_fan_out',
          include: 'writer',
          // One at a time: the failing slot comes first, and the queued one still runs.
          fan_out: { items: '[2,1]', as: 'item', max_parallel: 1, join: join_ },
          ...(upstream === undefined ? {} : { depends_on: [upstream.id] }),
        },
        {
          id: 'later',
          kind: 'exec',
          runtime: 'sh',
          script: `touch '${marker}'`,
          depends_on: ['fan'],
          trigger_rule: 'all_done',
          ...later,
        },
      ] as DagNode[];
      const result = await run('unknown-fan', nodes);
      const instances = (await result.store.listWorkflowEvents(result.runId)).filter(e =>
        e.step_name?.endsWith('__write')
      );
      return { ...result, marker, instances, nodes };
    };

    it('under all_done the queued instance runs, the join completes and the run goes on as today', async () => {
      const { store, runId, marker, instances } = await fanOut(true, 'all_done');
      expect(instances.filter(e => e.event_type === 'node_completed')).toHaveLength(1);
      expect(existsSync(marker)).toBe(true);
      expect((await store.getWorkflowRun(runId))?.status).toBe('completed');
    });

    it('under all_done a later timed wait still continues by itself', async () => {
      const { store, runId } = await fanOut(true, 'all_done', {
        kind: 'wait',
        wait: { duration_ms: 60_000 },
      } as Partial<DagNode>);
      const paused = await store.getWorkflowRun(runId);
      if (paused === null) throw new Error('run vanished');
      expect(paused.status).toBe('paused');
      expect(await claimWait(store, paused)).toMatchObject({ status: 'running' });
    });

    it('under all_done a recomputed join replays the absorbed failure, not the writer', async () => {
      const counter = join(testDir, 'count');
      // A changed output on the always_run upstream makes the join's cache stale on resume.
      const upstream = {
        id: 'up',
        kind: 'exec',
        runtime: 'sh',
        script: `n=$(cat '${counter}' 2>/dev/null || echo 0); echo $((n+1)) > '${counter}'; echo $n`,
        always_run: true,
      } as DagNode;
      const wait = { kind: 'wait', wait: { duration_ms: 60_000 } } as Partial<DagNode>;
      const { store, runId, deps, instances, nodes } = await fanOut(
        true,
        'all_done',
        wait,
        upstream
      );
      expect(instances.filter(e => e.event_type === 'node_failed')).toHaveLength(1);
      const paused = await store.getWorkflowRun(runId);
      const pending = paused === null ? undefined : pendingWorkflowWaitDeadline(paused);
      if (paused === null || pending === undefined) throw new Error('run is not at its wait');
      // The continuation host's claim of the wait, then its pass.
      const hydrated = await hydrateResumableRun(deps, paused, deadlineWaitCursor(pending));
      await executeDagWorkflow(
        dagOptions({
          deps,
          cwd: testDir,
          workflow: { name: 'unknown-fan', nodes },
          workflowRun: hydrated.preCreatedRun,
          priorCompletedNodes: hydrated.priorCompletedNodes,
        })
      );
      expect(await events(store, runId, 'node_started', 'up')).toHaveLength(2);
      const writes = (await store.listWorkflowEvents(runId)).filter(e =>
        e.step_name?.endsWith('__write')
      );
      expect(writes.filter(e => e.event_type === 'node_failed')).toHaveLength(1);
    });

    it('under all_done a later ordinary failure fails the run as today', async () => {
      const { store, runId } = await fanOut(true, 'all_done', { script: 'exit 1' });
      expect(await store.getWorkflowRun(runId)).toMatchObject({
        status: 'failed',
        metadata: { stop_reason: { reason: 'node_error' } },
      });
    });

    it('under all_success the run ends with the reason and attention names the instance', async () => {
      const { store, runId, marker, instances } = await fanOut(true, 'all_success');
      expect(instances.filter(e => e.event_type === 'node_completed')).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
      await expectEnded(store, runId);
      const [item] = await stoppedItems({
        ...store,
        getItem: async () => null,
        getCodebase: async () => null,
      });
      expect(item).toMatchObject({ kind: 'stopped', stoppedIn: { runId } });
      const outcomeUnknown =
        item !== undefined && 'failed' in item ? item.failed?.outcomeUnknown : undefined;
      expect(outcomeUnknown).toHaveLength(1);
      expect(outcomeUnknown?.[0]).toEndWith('__write');
    });

    it('under all_success a script contract failure (retryable: false) fails the run as today', async () => {
      const { store, runId } = await fanOut(false, 'all_success');
      expect(await store.getWorkflowRun(runId)).toMatchObject({
        status: 'failed',
        metadata: { stop_reason: { reason: 'node_error' } },
      });
    });
  });

  describe('inside a loop group body', () => {
    /** A body writer and an all_done cleanup after it, which an ordinary failure still runs. */
    const loopRun = async (write: Partial<DagNode>) => {
      const marker = join(testDir, 'cleaned');
      const result = await run('unknown-group', [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            nodes: [
              { id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1', ...write },
              {
                id: 'cleanup',
                kind: 'exec',
                runtime: 'sh',
                script: `touch '${marker}'`,
                depends_on: ['write'],
                trigger_rule: 'all_done',
              },
            ],
          },
        },
      ] as DagNode[]);
      return { ...result, marker };
    };

    it('starts no later body layer, fails the group, then ends the run', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      const { store, runId, marker } = await loopRun({});
      expect(existsSync(marker)).toBe(false);
      expect((await events(store, runId, 'node_failed', 'refine'))[0]?.data?.failure_kind).toBe(
        'child_failed'
      );
      await expectEnded(store, runId);
    });

    it('runs the cleanup and keeps node_error after a script contract failure (retryable: false)', async () => {
      const { store, runId, marker } = await loopRun(contractFailure as Partial<DagNode>);
      expect((await events(store, runId, 'node_failed', 'refine.write'))[0]?.data?.retryable).toBe(
        false
      );
      expect(existsSync(marker)).toBe(true);
      expect((await store.getWorkflowRun(runId))?.metadata).toMatchObject({
        stop_reason: { reason: 'node_error' },
      });
    });

    it('keeps node_error when a later round fails a join that absorbed an earlier round', async () => {
      await mkdir(join(testDir, '.archon', 'workflows'), { recursive: true });
      await writeFile(
        join(testDir, '.archon', 'workflows', 'writer.yaml'),
        [
          'name: writer',
          'description: block',
          'mutates_checkout: false',
          'inputs:',
          '  item: { required: true }',
          'nodes:',
          '  - id: write',
          `    bash: "if [ $INPUTS.item = 2 ]; then exit 1; fi"`,
        ].join('\n')
      );
      spy = failingWithOutcomeUnknown(['write']);
      const seen = join(testDir, 'seen');
      // Round one fans out over two items; round two's items are not a list.
      const { store, runId } = await run('unknown-rounds', [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 2,
            nodes: [
              {
                id: 'plan',
                kind: 'exec',
                runtime: 'sh',
                script: `if [ -f '${seen}' ]; then echo notjson; else touch '${seen}'; echo '[2,1]'; fi`,
              },
              {
                id: 'fan',
                kind: 'compose_fan_out',
                include: 'writer',
                depends_on: ['plan'],
                fan_out: { items: '$plan.output', as: 'item', join: 'all_done' },
              },
            ],
          },
        },
      ] as DagNode[]);
      expect(await events(store, runId, 'node_completed', 'refine.fan')).toHaveLength(1);
      expect(await store.getWorkflowRun(runId)).toMatchObject({
        status: 'failed',
        metadata: { stop_reason: { reason: 'node_error' } },
      });
    });
  });

  it('a later layer still runs after a script contract failure (retryable: false)', async () => {
    const marker = join(testDir, 'cleaned');
    const { store, runId } = await run('contract-later', [
      { id: 'write', kind: 'exec', runtime: 'sh', ...contractFailure },
      {
        id: 'cleanup',
        kind: 'exec',
        runtime: 'sh',
        script: `touch '${marker}'`,
        depends_on: ['write'],
        trigger_rule: 'all_done',
      },
    ] as DagNode[]);
    expect(existsSync(marker)).toBe(true);
    expect((await store.getWorkflowRun(runId))?.metadata).toMatchObject({
      stop_reason: { reason: 'node_error' },
    });
  });

  it('a hand resume runs the node again, and the run completes when it does', async () => {
    const marker = join(testDir, 'tried');
    const workflow = {
      name: 'unknown-resume',
      nodes: [
        // Its first node: fails once (recorded as an unknown outcome), succeeds when run again.
        {
          id: 'write',
          kind: 'exec',
          runtime: 'sh',
          script: `test -f '${marker}' || { touch '${marker}'; exit 1; }`,
        },
      ] as DagNode[],
    };
    spy = failingWithOutcomeUnknown(['write']);
    const { store, runId, deps } = await run(workflow.name, workflow.nodes);
    await expectEnded(store, runId);
    spy.mockRestore();
    spy = undefined;
    const failed = await store.getWorkflowRun(runId);
    if (failed === null) throw new Error('run vanished');
    // The resume by hand: it claims the failed run and runs its failed node again.
    const hydrated = await hydrateResumableRun(deps, failed);
    await executeDagWorkflow(
      dagOptions({
        deps,
        cwd: testDir,
        workflow,
        workflowRun: hydrated.preCreatedRun,
        priorCompletedNodes: hydrated.priorCompletedNodes,
      })
    );
    expect(await events(store, runId, 'node_started', 'write')).toHaveLength(2);
    expect((await store.getWorkflowRun(runId))?.status).toBe('completed');
  });
});
