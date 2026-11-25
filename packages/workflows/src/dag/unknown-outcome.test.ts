// @archon-test-isolated
/**
 * A node that fails over its own unknown outcome, or one of what ran under it, ends the run
 * at once, with stop reason `outcome_unknown`; another node's ordinary failure does not. No
 * built-in node records the kind yet, so these tests have the engine's own `recordNodeState`
 * record it for the named nodes; everything past that write (retry, persistence, aggregates,
 * the walk, the store's transitions) runs as for a real producer, against a real file store.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as nodeEventWrite from '../node-event-write';
import * as settle from './unknown-outcome';
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
const realReachedUnknownOutcome = settle.reachedUnknownOutcome;

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

  /** An operator's resume by hand of the failed run, and its pass. */
  async function resumeByHand(
    { store, runId, deps }: { store: IWorkflowStore; runId: string; deps: WorkflowDeps },
    workflow: { name: string; nodes: DagNode[] }
  ): Promise<void> {
    const failed = await store.getWorkflowRun(runId);
    if (failed === null) throw new Error('run vanished');
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
  }

  /** The continuation host's automatic claim of the run's pending timed wait. */
  async function claimWait(store: IWorkflowStore, run: WorkflowRun): Promise<unknown> {
    const wait = pendingWorkflowWaitDeadline(run);
    if (wait === undefined) throw new Error('run is not paused at a timed wait');
    return store.resumeWorkflowRun(run.id, deadlineWaitCursor(wait)).catch((err: unknown) => err);
  }

  /**
   * A writer that fails once its sibling's pause committed: `pausing` makes the store's
   * pause writes touch the marker after they commit, and records the row each one left.
   */
  const afterPause = (marker: string): string =>
    `for i in $(seq 500); do [ -f '${marker}' ] && break; sleep 0.01; done; exit 1`;
  function pausing(store: IWorkflowStore, marker: string, rows: WorkflowRun[]): void {
    const committed = async (id: string): Promise<void> => {
      const row = await store.getWorkflowRun(id);
      if (row !== null) rows.push(row);
      await writeFile(marker, '');
    };
    const pause = store.pauseWorkflowRun.bind(store);
    spyOn(store, 'pauseWorkflowRun').mockImplementation(async (id, ...rest) => {
      const result = await pause(id, ...rest);
      await committed(id);
      return result;
    });
    const wait = store.pauseWorkflowRunForWait.bind(store);
    spyOn(store, 'pauseWorkflowRunForWait').mockImplementation(async (id, ...rest) => {
      const result = await wait(id, ...rest);
      await committed(id);
      return result;
    });
  }
  /** The writer and a sibling that pauses the run, the writer failing after the pause. */
  const pausedSibling = (marker: string, sibling: DagNode, write: Partial<DagNode> = {}) =>
    [
      { id: 'write', kind: 'exec', runtime: 'sh', script: afterPause(marker), ...write },
      sibling,
    ] as DagNode[];
  const timedWait = { id: 'delay', kind: 'wait', wait: { duration_ms: 60_000 } } as DagNode;

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
      const marker = join(testDir, 'paused');
      const rows: WorkflowRun[] = [];
      const { store, runId } = await run(
        'unknown-race',
        pausedSibling(marker, timedWait, alwaysRun ? { always_run: true } : {}),
        { prepare: store => pausing(store, marker, rows) }
      );
      expect(rows.map(row => row.status)).toEqual(['paused']);
      expect(await events(store, runId, 'node_started', 'write')).toHaveLength(1);
      await expectEnded(store, runId);
    }
  );

  it('ends a run that a parallel approval gate already paused', async () => {
    spy = failingWithOutcomeUnknown(['write']);
    const marker = join(testDir, 'paused');
    const rows: WorkflowRun[] = [];
    const gate = {
      id: 'review',
      kind: 'gate',
      message: 'Review',
      decisions: [{ id: 'approve' }],
      decisionsAuthored: false,
      captureResponse: false,
    } as DagNode;
    const { store, runId } = await run('unknown-gate', pausedSibling(marker, gate), {
      prepare: store => pausing(store, marker, rows),
    });
    // The gate's pause committed, then the writer's failure turned the paused row failed.
    expect(rows.map(row => row.status)).toEqual(['paused']);
    await expectEnded(store, runId);
  });

  it('keeps the record and refuses the claim when the run-failing read fails', async () => {
    // Only the writer's own failure: a record written over it must not read as unknown.
    spy = failingWithOutcomeUnknown(['write'], { once: true });
    let paused: WorkflowRun | undefined;
    let store: IWorkflowStore | undefined;
    const marker = join(testDir, 'paused');
    await run('unknown-read-fault', pausedSibling(marker, timedWait), {
      prepare: faulted => {
        store = faulted;
        pausing(faulted, marker, []);
        const read = faulted.listEventsForRuns.bind(faulted);
        spyOn(faulted, 'listEventsForRuns').mockImplementation(async (ids, types) => {
          const id = ids[0] ?? '';
          const recorded = (await faulted.listWorkflowEvents(id)).some(
            e => e.event_type === 'node_failed' && e.step_name === 'write'
          );
          // The settle point's read, once the writer's failure record is stored.
          if (paused === undefined && recorded && types?.includes('fan_out_instances')) {
            paused = (await faulted.getWorkflowRun(id)) ?? undefined;
            throw new Error('store unavailable');
          }
          return read(ids, types);
        });
      },
    }).catch(() => undefined);
    if (store === undefined || paused === undefined) throw new Error('the read never failed');
    expect(paused.status).toBe('paused');
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
    const marker = join(testDir, 'paused');
    const { store, runId } = await run('unknown-claim', pausedSibling(marker, timedWait), {
      // Between the stored failure and the run's fail: the run is paused at the wait.
      prepare: store => {
        pausing(store, marker, []);
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
    });
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
      {
        later,
        upstream,
        cleanup,
      }: {
        later?: Partial<DagNode>;
        /** A node the fan-out depends on. */
        upstream?: DagNode;
        /** A file each instance's all_done cleanup, after its writer, appends to. */
        cleanup?: string;
      } = {}
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
          ...(cleanup === undefined
            ? []
            : [
                '  - id: cleanup',
                `    bash: "echo x >> '${cleanup}'"`,
                '    depends_on: [write]',
                '    trigger_rule: all_done',
              ]),
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
        later: { kind: 'wait', wait: { duration_ms: 60_000 } } as Partial<DagNode>,
      });
      const paused = await store.getWorkflowRun(runId);
      if (paused === null) throw new Error('run vanished');
      expect(paused.status).toBe('paused');
      expect(await claimWait(store, paused)).toMatchObject({ status: 'running' });
    });

    /** An always_run upstream whose changed output makes the join's cache stale on resume. */
    const counter = (): DagNode =>
      ({
        id: 'up',
        kind: 'exec',
        runtime: 'sh',
        script: `n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count; echo $n`,
        always_run: true,
      }) as DagNode;
    const laterWait = { kind: 'wait', wait: { duration_ms: 60_000 } } as Partial<DagNode>;

    /** The continuation host's claim of the run's timed wait, then its pass. */
    async function continueAtWait(
      { store, runId, deps }: { store: IWorkflowStore; runId: string; deps: WorkflowDeps },
      nodes: DagNode[]
    ): Promise<void> {
      const paused = await store.getWorkflowRun(runId);
      const pending = paused === null ? undefined : pendingWorkflowWaitDeadline(paused);
      if (paused === null || pending === undefined) throw new Error('run is not at its wait');
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
    }
    const writeFailures = async (store: IWorkflowStore, runId: string) =>
      (await store.listWorkflowEvents(runId)).filter(
        e => e.event_type === 'node_failed' && e.step_name?.endsWith('__write')
      );

    it('under all_done a failure recorded after its join last completed stays live', async () => {
      // First pass: an ordinary failure, which the join absorbs and a recompute runs again.
      const cleaned = join(testDir, 'cleaned');
      const result = await fanOut(false, 'all_done', {
        later: laterWait,
        upstream: counter(),
        cleanup: cleaned,
      });
      expect((await readFile(cleaned, 'utf8')).trim().split('\n')).toHaveLength(2);
      // Second pass: the rerun writer's outcome is unknown, recorded after the join completed.
      spy = failingWithOutcomeUnknown(['write']);
      await continueAtWait(result, result.nodes);
      expect(await writeFailures(result.store, result.runId)).toHaveLength(2);
      expect((await readFile(cleaned, 'utf8')).trim().split('\n')).toHaveLength(2);
    });

    it('under all_done a recomputed join gets the absorbed failure back and does not run the writer again', async () => {
      const result = await fanOut(true, 'all_done', { later: laterWait, upstream: counter() });
      expect(await writeFailures(result.store, result.runId)).toHaveLength(1);
      await continueAtWait(result, result.nodes);
      expect(await writeFailures(result.store, result.runId)).toHaveLength(1);
      // The recomputed join completed over the replayed failure, its slot still marked failed.
      const joins = await events(result.store, result.runId, 'node_completed', 'fan');
      expect(joins).toHaveLength(2);
      const slots = JSON.parse(String(joins[1]?.data?.node_output)) as unknown[];
      expect(slots).toHaveLength(2);
      expect(slots[0]).toMatchObject({ archon_failed: true });
    });

    it('a hand resume runs an outer instance again when only an inner join absorbed the uncertain write', async () => {
      const workflows = join(testDir, '.archon', 'workflows');
      await mkdir(workflows, { recursive: true });
      const marker = join(testDir, 'tried');
      await writeFile(
        join(workflows, 'writer.yaml'),
        [
          'name: writer',
          'description: block',
          'mutates_checkout: false',
          'inputs:',
          '  item: { required: true }',
          'nodes:',
          '  - id: write',
          '    bash: "exit 1"',
        ].join('\n')
      );
      // The outer block: an inner all_done fan-out over the writer, and a step that fails once.
      await writeFile(
        join(workflows, 'outer.yaml'),
        [
          'name: outer',
          'description: block',
          'mutates_checkout: false',
          'inputs:',
          '  item: { required: true }',
          'nodes:',
          '  - id: inner',
          '    include: writer',
          "    fan_out: { items: '[2]', as: item, join: all_done }",
          '  - id: step',
          `    bash: "test -f '${marker}' || { touch '${marker}'; exit 1; }"`,
        ].join('\n')
      );
      spy = failingWithOutcomeUnknown(['write']);
      const workflow = {
        name: 'unknown-nested',
        nodes: [
          {
            id: 'fan',
            kind: 'compose_fan_out',
            include: 'outer',
            fan_out: { items: '[1]', as: 'item', join: 'all_success' },
          },
        ] as DagNode[],
      };
      const result = await run(workflow.name, workflow.nodes);
      expect((await result.store.getWorkflowRun(result.runId))?.metadata).toMatchObject({
        stop_reason: { reason: 'node_error' },
      });
      await resumeByHand(result, workflow);
      const started = (await result.store.listWorkflowEvents(result.runId)).filter(
        e => e.event_type === 'node_started'
      );
      expect(started.filter(e => e.step_name?.endsWith('__step'))).toHaveLength(2);
      expect(started.filter(e => e.step_name?.endsWith('__write'))).toHaveLength(1);
      expect((await result.store.getWorkflowRun(result.runId))?.status).toBe('completed');
    });

    it.each([
      ['a disjoint id', 'other', 'fan'],
      // The fan-out's scope name starts with the scope `fan` would have, plus `__`.
      ['an id the fan-out scope extends', 'fan', 'fan__root__writer'],
    ])(
      'an ordinary failure beside a running all_done fan-out keeps node_error (%s)',
      async (_case, beside, fanId) => {
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
            '    bash: "if [ $INPUTS.item = 2 ]; then exit 1; fi"',
          ].join('\n')
        );
        // Item 2's writer records the unknown outcome. The beside node is judged only after
        // that record, and item 1's writer completes (the join can absorb) only after that.
        const recorded = Promise.withResolvers<void>();
        const judged = Promise.withResolvers<void>();
        spy = spyOn(nodeEventWrite, 'recordNodeState').mockImplementation(
          async (sinks, record, continuation) => {
            if ('cache' in record || !record.node.id.endsWith('__write'))
              return realRecordNodeState(sinks, record, continuation);
            if (record.lifecycle.status === 'completed') await judged.promise;
            if (record.lifecycle.status !== 'failed')
              return realRecordNodeState(sinks, record, continuation);
            const lifecycle = { ...record.lifecycle, failureKind: 'outcome_unknown' as const };
            const written = await realRecordNodeState(
              sinks,
              { ...record, lifecycle },
              continuation
            );
            recorded.resolve();
            return written;
          }
        );
        const decisions: [string, boolean][] = [];
        const decide = spyOn(settle, 'reachedUnknownOutcome').mockImplementation(
          async (ctx, node, settled) => {
            if (node.id === beside) await recorded.promise;
            const reached = await realReachedUnknownOutcome(ctx, node, settled);
            decisions.push([node.id, reached]);
            if (node.id === beside) judged.resolve();
            return reached;
          }
        );
        try {
          const { store, runId } = await run('unknown-beside', [
            {
              id: fanId,
              kind: 'compose_fan_out',
              include: 'writer',
              fan_out: { items: '[2,1]', as: 'item', max_parallel: 1, join: 'all_done' },
            },
            { id: beside, kind: 'exec', runtime: 'sh', script: 'exit 1' },
          ] as DagNode[]);
          expect(decisions).toContainEqual([beside, false]);
          expect(await events(store, runId, 'node_completed', fanId)).toHaveLength(1);
          expect(await store.getWorkflowRun(runId)).toMatchObject({
            status: 'failed',
            metadata: { stop_reason: { reason: 'node_error' } },
          });
        } finally {
          decide.mockRestore();
        }
      }
    );

    it('under all_done a later ordinary failure fails the run as today', async () => {
      const { store, runId } = await fanOut(true, 'all_done', { later: { script: 'exit 1' } });
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

    it('a peer whose ordinary failure settles last does not clear the stop', async () => {
      const marker = join(testDir, 'cleaned');
      // `other` decides first, before `write`'s failure record exists, so its answer is no.
      // `write`'s record is held until then, and `other`'s answer is handed back only after
      // `write` set the stop: the ordinary failure settles last.
      const otherDecided = Promise.withResolvers<void>();
      const writerStopped = Promise.withResolvers<void>();
      const decisions: [string, boolean][] = [];
      spy = spyOn(nodeEventWrite, 'recordNodeState').mockImplementation(
        async (sinks, record, continuation) => {
          if (
            'cache' in record ||
            record.lifecycle.status !== 'failed' ||
            record.node.id !== 'write'
          )
            return realRecordNodeState(sinks, record, continuation);
          await otherDecided.promise;
          const lifecycle = { ...record.lifecycle, failureKind: 'outcome_unknown' as const };
          return realRecordNodeState(sinks, { ...record, lifecycle }, continuation);
        }
      );
      const decide = spyOn(settle, 'reachedUnknownOutcome').mockImplementation(
        async (ctx, node, settled) => {
          const reached = await realReachedUnknownOutcome(ctx, node, settled);
          decisions.push([settled.nodeId, reached]);
          if (settled.nodeId === 'write') writerStopped.resolve();
          if (settled.nodeId !== 'other') return reached;
          otherDecided.resolve();
          await writerStopped.promise;
          await new Promise(resolve => setTimeout(resolve, 0));
          return reached;
        }
      );
      try {
        const { store, runId } = await run('unknown-group-race', [
          {
            id: 'refine',
            kind: 'loop_group',
            loop_group: {
              until: 'DONE',
              max_iterations: 3,
              nodes: [
                { id: 'write', kind: 'exec', runtime: 'sh', script: 'exit 1' },
                { id: 'other', kind: 'exec', runtime: 'sh', script: 'exit 1' },
                {
                  id: 'cleanup',
                  kind: 'exec',
                  runtime: 'sh',
                  script: `touch '${marker}'`,
                  depends_on: ['write', 'other'],
                  trigger_rule: 'all_done',
                },
              ],
            },
          },
        ] as DagNode[]);
        // Both peers decided, `other` first and without an unknown outcome to see.
        expect(decisions.filter(([id]) => id === 'other' || id === 'write')).toEqual([
          ['other', false],
          ['write', true],
        ]);
        expect(existsSync(marker)).toBe(false);
        await expectEnded(store, runId);
      } finally {
        decide.mockRestore();
      }
    });

    it('starts no queued peer of the same body layer', async () => {
      spy = failingWithOutcomeUnknown(['write']);
      const marker = join(testDir, 'peer');
      // A checkout-guarded writer beside an unguarded peer runs the layer one at a time.
      const { store, runId } = await run('unknown-group-serial', [
        {
          id: 'refine',
          kind: 'loop_group',
          loop_group: {
            until: 'DONE',
            max_iterations: 3,
            nodes: [
              {
                id: 'write',
                kind: 'exec',
                runtime: 'sh',
                script: 'exit 1',
                mutates_checkout: false,
              },
              { id: 'peer', kind: 'exec', runtime: 'sh', script: `touch '${marker}'` },
            ],
          },
        },
      ] as DagNode[]);
      expect(existsSync(marker)).toBe(false);
      await expectEnded(store, runId);
    });

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

  it.each([
    ['disjoint ids', 'write', { id: 'prep', kind: 'exec', runtime: 'sh', script: 'exit 1' }],
    [
      'a dotted sibling',
      'prep.write',
      { id: 'prep', kind: 'exec', runtime: 'sh', script: 'exit 1' },
    ],
    [
      'a dotted sibling of a loop group',
      'prep.write',
      {
        id: 'prep',
        kind: 'loop_group',
        loop_group: {
          until: 'DONE',
          max_iterations: 1,
          nodes: [{ id: 'step', kind: 'exec', runtime: 'sh', script: 'exit 1' }],
        },
      },
    ],
  ] as const)(
    'a hand resume past an ordinary failure reaches the uncertain node (%s)',
    async (_case, writer, prep) => {
      const workflow = {
        name: 'unknown-past',
        nodes: [
          prep,
          {
            id: writer,
            kind: 'exec',
            runtime: 'sh',
            script: 'exit 1',
            depends_on: ['prep'],
            trigger_rule: 'all_done',
          },
        ] as DagNode[],
      };
      spy = failingWithOutcomeUnknown([writer]);
      const result = await run(workflow.name, workflow.nodes);
      await expectEnded(result.store, result.runId);
      for (const pass of [2, 3]) {
        await resumeByHand(result, workflow);
        expect(await events(result.store, result.runId, 'node_started', writer)).toHaveLength(pass);
        await expectEnded(result.store, result.runId);
      }
    }
  );

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
