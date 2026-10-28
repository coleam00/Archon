// @archon-test-isolated
import {
  mockLogger,
  telemetryResumeFlags,
  holdSourceRemoval,
  makeDeps,
  makePlatform,
  realArchonPaths,
} from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import { InProcessWorkflowEngine } from './in-process-engine';
import { ParentStatusReadError } from './parent-status-read';
import { continueBlockedRun } from './parent-resume';
import { isApprovalContext, type WorkflowRunOrigin } from './schemas/workflow-run';
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdir, writeFile, rm, readFile, chmod } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { prepareRunAiConfiguration } from './run-preflight';
import { captureWorkflowSource, resolveRunSourceCapture } from './workflow-source';
import { discoverWorkflows } from './workflow-discovery';
import type { IWorkflowStore } from './store';
import { sourceReleaseMetadata, sourceReleasedEvent } from './store';
import type { ResolvedWorkflow } from './schemas/workflow';

/** A `workflow:` node runs, pauses, resumes and fails one governed child run. */
describe('workflow: sub-run e2e (#2121 Phase 2)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<ResolvedWorkflow> {
    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    const wf = result.workflows.find(w => w.workflow.name === name);
    if (!wf) throw new Error(`workflow ${name} not found: ${JSON.stringify(result.errors)}`);
    return wf.workflow;
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `subrun-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await removeTempTree(cwd);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  async function recoverInterruptedChildren(
    store: InMemoryStore,
    deps: ReturnType<typeof makeDeps>,
    fanOut: boolean,
    priorPaidAttempts = 0
  ): Promise<void> {
    for (const run of store.runs.values()) {
      if (run.workflow_name !== 'target') continue;
      // Explicit operator recovery, after the interrupted owner has returned.
      await store.updateWorkflowRun(run.id, { status: 'paused' });
      const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(run.id))!);
      if (!hydrated) throw new Error('Child not resumable');
      await executeWorkflow(
        deps,
        makePlatform(),
        'test',
        cwd,
        await discover('target'),
        'goal',
        undefined,
        hydrated
      );
    }
    const outer = [...store.runs.values()].find(run => run.workflow_name === 'outer')!;
    const snapshot = await store.getDagResumeSnapshot(outer.id);
    await executeWorkflow(
      deps,
      makePlatform(),
      'test',
      cwd,
      await discover('outer'),
      'goal',
      undefined,
      {
        preCreatedRun: outer,
        priorCompletedNodes: snapshot.completedNodeOutputs,
        priorUsage: snapshot,
      }
    );
    expect((await store.getWorkflowRun(outer.id))?.status).toBe('completed');
    expect((await store.getWorkflowRun(outer.id))?.metadata).toMatchObject({
      total_cost_usd: (fanOut ? 0.03 : 0.02) + priorPaidAttempts * 0.01,
      total_tokens_in: (fanOut ? 21 : 14) + priorPaidAttempts * 7,
      total_tokens_out: (fanOut ? 9 : 6) + priorPaidAttempts * 3,
      total_cache_read_tokens: (fanOut ? 15 : 10) + priorPaidAttempts * 5,
      total_cache_write_tokens: 0,
    });
    expect(
      store.events.filter(
        event => event.event_type === 'node_completed' && event.data?.type === 'agent'
      )
    ).toHaveLength((fanOut ? 3 : 2) + priorPaidAttempts);
  }

  it.each([false, true])(
    'retains paid child baselines across credential refusal (fan-out=%p)',
    async fanOut => {
      await writeWorkflow(
        'paid-retry',
        `name: paid-retry
description: paid attempts
nodes:
  - id: work
    prompt: paid attempt
    provider: codex
    model: gpt-5.4
    always_run: true
  - id: fail
    bash: exit 1
    depends_on: [work]
`
      );
      await writeWorkflow(
        'retry-parent',
        `name: retry-parent
description: retry paid child
nodes:
  - id: seed
    bash: echo seed
  - id: sub
    workflow: paid-retry
    depends_on: [seed]
${fanOut ? "    fan_out:\n      items: '[1]'\n      as: item\n      join: all_success\n" : ''}`
      );
      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const workflow = await discover('retry-parent');
      await executeWorkflow(deps, makePlatform(), 'test', cwd, workflow, 'goal', {
        userId: 'operator',
      });
      const parent = [...store.runs.values()].find(run => run.workflow_name === 'retry-parent');
      const child = [...store.runs.values()].find(run => run.workflow_name === 'paid-retry');
      if (!parent || !child) throw new Error('Missing parent or child');
      expect(parent.metadata.total_cost_usd).toBeCloseTo(0.01);
      expect(child.metadata.total_cost_usd).toBeCloseTo(0.01);
      const retry = async () => {
        const current = await store.getWorkflowRun(parent.id);
        if (!current) throw new Error('Missing parent');
        const hydrated = await hydrateResumableRun(deps, current);
        if (!hydrated) throw new Error('Parent not resumable');
        return executeWorkflow(
          deps,
          makePlatform(),
          'test',
          cwd,
          workflow,
          'goal',
          { userId: 'operator' },
          hydrated
        );
      };
      deps.isPerUserProviderKeysEnabled = () => true;
      deps.getUserProviderCredential = async () => ({
        kind: 'api_key',
        getStatus: async () => ({
          state: 'unusable',
          source: 'archon',
          evidence: 'credential unavailable',
        }),
      });
      await retry();
      expect(
        store.events.some(
          event =>
            event.workflow_run_id === parent.id &&
            event.event_type === 'node_failed' &&
            String(event.data?.error).includes('Credential preflight failed')
        )
      ).toBe(true);
      const refused = await store.getDagResumeSnapshot(parent.id);
      expect(refused.reportedChildUsage?.get(child.id)?.costUsd).toBeCloseTo(0.01);
      deps.isPerUserProviderKeysEnabled = () => false;
      await retry();
      expect((await store.getWorkflowRun(child.id))?.metadata.total_cost_usd).toBeCloseTo(0.02);
      expect((await store.getWorkflowRun(parent.id))?.metadata).toMatchObject({
        total_cost_usd: expect.closeTo(0.02),
        total_tokens_in: 14,
        total_tokens_out: 6,
      });
      expect(
        [...store.runs.values()].filter(run => run.workflow_name === 'paid-retry')
      ).toHaveLength(1);
    }
  );

  type InterruptionCaller = 'child' | 'child fan-out' | 'engine resume' | 'automatic resume';

  async function driveUnreadableParent(
    caller: InterruptionCaller,
    store: InMemoryStore,
    deps: ReturnType<typeof makeDeps>
  ): Promise<unknown> {
    if (caller === 'child' || caller === 'child fan-out') {
      return executeWorkflow(deps, makePlatform(), 'test', cwd, await discover('outer'), 'goal');
    } else {
      const run = await store.createWorkflowRun({
        workflow_name: 'target',
        user_message: '',
        working_path: cwd,
      });
      await store.updateWorkflowRun(run.id, {
        status: 'paused',
        metadata: {
          approval: {
            type: 'child_workflow',
            nodeId: 'fan',
            childRunId: 'finished-child',
            message: 'waiting',
          },
        },
      });
      const paused = await store.getWorkflowRun(run.id);
      if (!paused) throw new Error('Missing paused run');
      if (caller === 'engine resume') {
        const admission = await new InProcessWorkflowEngine(deps).resume({
          platform: makePlatform(),
          conversationId: 'test',
          cwd,
          userMessage: '',
          run: paused,
          legacyWorkflow: await discover('target'),
        });
        if (!admission.accepted) throw new Error('Resume was not admitted');
        return admission.settled;
      } else {
        return continueBlockedRun(deps, makePlatform(), 'test', paused, async () => {}, {});
      }
    }
  }

  for (const caller of ['child', 'child fan-out', 'engine resume', 'automatic resume'] as const) {
    it(`preserves unreadable composed parent through ${caller}`, async () => {
      await writeWorkflow(
        'block',
        `name: block
description: work
nodes:
  - id: work
    prompt: work
`
      );
      await writeWorkflow(
        'target',
        `name: target
description: composed parent
nodes:
  - id: fan
    include: block
    fan_out:
      items: '[1]'
      as: item
      join: all_success
`
      );
      await writeWorkflow(
        'outer',
        `name: outer
description: enclosing parent
nodes:
  - id: sibling
    prompt: paid sibling
  - id: sub
    workflow: target
${caller === 'child fan-out' ? "    fan_out:\n      items: '[1,2]'\n      as: item\n" : ''}`
      );
      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const cause = Object.assign(new Error('Unsupported workflow status: unsupported'), {
        name: 'WorkflowStatusReadError',
        rawStatus: 'unsupported',
      });
      const readStatus = store.getWorkflowRunStatus;
      let readsAfterRejection = 0;
      const rejectedRuns = new Set<string>();
      store.getWorkflowRunStatus = async id => {
        const settled = store.events.some(
          event =>
            event.workflow_run_id === id &&
            event.event_type === 'node_completed' &&
            event.data?.type === 'compose_fan_out_instance'
        );
        if (rejectedRuns.has(id)) readsAfterRejection++;
        if (settled && !rejectedRuns.has(id)) {
          rejectedRuns.add(id);
          throw cause;
        }
        return readStatus(id);
      };
      const fail = spyOn(store, 'failWorkflowRun');
      const cancel = spyOn(store, 'cancelWorkflowRun');
      const complete = spyOn(store, 'completeWorkflowRun');
      const pause = spyOn(store, 'pauseWorkflowRun');
      const execution = driveUnreadableParent(caller, store, deps);
      const error: unknown = await execution.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ParentStatusReadError);
      if (!(error instanceof ParentStatusReadError))
        throw new Error('Expected lifecycle interruption');
      expect(error.cause).toBe(cause);
      expect(rejectedRuns.size).toBeGreaterThan(0);
      expect(readsAfterRejection).toBe(0);
      expect([...store.runs.values()].every(run => run.status === 'running')).toBe(true);
      expect(store.events.some(event => event.event_type === 'node_failed')).toBe(false);
      expect(fail).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      for (const run of store.runs.values()) {
        const units = run.workflow_name === 'outer' ? (caller === 'child fan-out' ? 3 : 2) : 1;
        expect(run.metadata).toMatchObject({
          total_cost_usd: 0.01 * units,
          total_tokens_in: 7 * units,
          total_tokens_out: 3 * units,
          total_cache_read_tokens: 5 * units,
          total_cache_write_tokens: 0,
        });
      }
    });
  }

  it.each([
    { fanOut: false, replacement: false, interrupted: true },
    { fanOut: true, replacement: false, interrupted: true },
    { fanOut: false, replacement: true, interrupted: false },
    { fanOut: true, replacement: true, interrupted: false },
    { fanOut: false, replacement: true, interrupted: true },
    { fanOut: true, replacement: true, interrupted: true },
    { fanOut: true, replacement: 'mixed', interrupted: false },
    { fanOut: true, replacement: 'mixed', interrupted: true },
  ])('retains paid usage on recovery: %j', async ({ fanOut, replacement, interrupted }) => {
    await writeWorkflow(
      'block',
      `name: block
description: paid work
nodes:
  - id: work
    prompt: work
`
    );
    await writeWorkflow(
      'target',
      `name: target
description: fails after paid work on its first pass
nodes:
  - id: paid
    prompt: first attempt
  - id: attempt
    bash: test -f retry-marker
    depends_on: [paid]
  - id: fan
    include: block
    depends_on: [attempt]
    fan_out:
      items: '[1]'
      as: item
`
    );
    await writeWorkflow(
      'outer',
      `name: outer
description: retrying parent
nodes:
  - id: sibling
    prompt: paid sibling
  - id: sub
    workflow: target
${fanOut ? "    fan_out:\n      items: '[1,2]'\n      as: item\n      max_parallel: 1\n      join: all_success\n" : ''}`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    await executeWorkflow(deps, makePlatform(), 'test', cwd, await discover('outer'), 'goal');
    const outer = [...store.runs.values()].find(run => run.workflow_name === 'outer')!;
    expect(outer.status).toBe('failed');
    const children = [...store.runs.values()].filter(run => run.workflow_name === 'target');
    expect(children).toHaveLength(fanOut ? 2 : 1);
    expect(children.every(run => run.status === 'failed')).toBe(true);
    const replaced = replacement === 'mixed' ? children.slice(1) : replacement ? children : [];
    replaced.forEach(child => store.runs.delete(child.id));
    await writeFile(join(cwd, 'retry-marker'), 'retry');
    const readStatus = store.getWorkflowRunStatus;
    const cause = new Error('Unsupported workflow status');
    if (interrupted)
      store.getWorkflowRunStatus = async id => {
        if (
          store.events.some(
            event =>
              event.workflow_run_id === id &&
              event.event_type === 'node_completed' &&
              event.data?.type === 'compose_fan_out_instance'
          )
        )
          throw cause;
        return readStatus(id);
      };
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(outer.id))!);
    if (!hydrated) throw new Error('Parent not resumable');
    const error: unknown = await executeWorkflow(
      deps,
      makePlatform(),
      'test',
      cwd,
      await discover('outer'),
      'goal',
      undefined,
      hydrated
    ).catch((error: unknown) => error);
    if (interrupted) {
      if (!(error instanceof ParentStatusReadError))
        throw new Error('Expected lifecycle interruption');
      expect(error.cause).toBe(cause);
    }
    const paidCalls = 1 + children.length * 2 + replaced.length;
    expect((await store.getWorkflowRun(outer.id))?.metadata).toMatchObject({
      total_cost_usd: paidCalls * 0.01,
      total_tokens_in: paidCalls * 7,
      total_tokens_out: paidCalls * 3,
      total_cache_read_tokens: paidCalls * 5,
      total_cache_write_tokens: 0,
    });
    expect((await store.getWorkflowRun(outer.id))?.status).toBe(
      interrupted ? 'running' : 'completed'
    );
    store.getWorkflowRunStatus = readStatus;
    if (!replacement) await recoverInterruptedChildren(store, deps, fanOut, fanOut ? 2 : 1);
  });

  it.each(['dag', 'composed instance'] as const)(
    'stops on a rejected between-layer status read in %s',
    async scope => {
      const body = `  - id: first
    prompt: first
  - id: second
    prompt: second
    depends_on: [first]`;
      await writeWorkflow(
        'block',
        `name: block
description: work
nodes:
${body}
`
      );
      const nodes =
        scope === 'dag'
          ? body
          : `  - id: fan
    include: block
    fan_out:
      items: '[1]'
      as: item`;
      await writeWorkflow(
        'layers',
        `name: layers
description: work
nodes:
${nodes}
`
      );
      const store = new InMemoryStore();
      const readStatus = store.getWorkflowRunStatus;
      const cause = new Error('Unsupported persisted status');
      let rejected = false;
      store.getWorkflowRunStatus = async id => {
        if (
          !rejected &&
          store.events.some(
            event =>
              event.workflow_run_id === id &&
              event.event_type === 'node_completed' &&
              event.step_name?.endsWith('first')
          )
        ) {
          rejected = true;
          throw cause;
        }
        return readStatus(id);
      };
      const fail = spyOn(store, 'failWorkflowRun');
      const complete = spyOn(store, 'completeWorkflowRun');
      const error: unknown = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'test',
        cwd,
        await discover('layers'),
        'goal'
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ParentStatusReadError);
      if (!(error instanceof ParentStatusReadError))
        throw new Error('Expected lifecycle interruption');
      expect(error.cause).toBe(cause);
      expect(store.events.some(event => event.step_name?.endsWith('second'))).toBe(false);
      expect(store.events.some(event => event.event_type === 'node_failed')).toBe(false);
      expect(fail).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect([...store.runs.values()][0]?.metadata.total_cost_usd).toBe(0.01);
    }
  );

  it('propagates a rejected loop-group status read after the body', async () => {
    await writeWorkflow(
      'group-status',
      `name: group-status
description: loop lifecycle
nodes:
  - id: group
    loop_group:
      until: DONE
      max_iterations: 1
      nodes:
        - id: work
          prompt: work
`
    );
    const store = new InMemoryStore();
    const readStatus = store.getWorkflowRunStatus;
    const cause = Object.assign(new Error('Unsupported workflow status'), {
      name: 'WorkflowStatusReadError',
    });
    let readsAfterBody = 0;
    store.getWorkflowRunStatus = async id => {
      const bodySettled = store.events.some(
        event => event.step_name === 'group.work' && event.event_type === 'node_completed'
      );
      // The second read after the body settles is the group's own post-body read.
      if (bodySettled && ++readsAfterBody === 2) throw cause;
      return readStatus(id);
    };
    const fail = spyOn(store, 'failWorkflowRun');
    const complete = spyOn(store, 'completeWorkflowRun');
    const error: unknown = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'test',
      cwd,
      await discover('group-status'),
      'goal'
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ParentStatusReadError);
    if (!(error instanceof ParentStatusReadError))
      throw new Error('Expected lifecycle interruption');
    expect(error.cause).toBe(cause);
    expect(store.events.some(event => event.event_type === 'node_failed')).toBe(false);
    expect(fail).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect([...store.runs.values()][0]?.status).toBe('running');
    expect([...store.runs.values()][0]?.metadata.total_cost_usd).toBe(0.01);
  });

  it('automatically resumes a parent after its gated child fails', async () => {
    await writeWorkflow(
      'fails-after-gate',
      `name: fails-after-gate
description: failed gated child
nodes:
  - id: gate
    approval:
      message: approve
  - id: fail
    bash: exit 1
    depends_on: [gate]
`
    );
    await writeWorkflow(
      'parent-failed-child',
      `name: parent-failed-child
description: parent
nodes:
  - id: sub
    workflow: fails-after-gate
  - id: after
    prompt: must not run
    depends_on: [sub]
`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    await executeWorkflow(
      deps,
      makePlatform(),
      'test',
      cwd,
      await discover('parent-failed-child'),
      'goal'
    );
    const parent = [...store.runs.values()].find(
      run => run.workflow_name === 'parent-failed-child'
    )!;
    const child = [...store.runs.values()].find(run => run.workflow_name === 'fails-after-gate')!;
    expect(parent.status).toBe('paused');
    expect(child.status).toBe('paused');
    store.approveGate(child.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child.id))!);
    if (!hydrated) throw new Error('Child not resumable');
    await executeWorkflow(
      deps,
      makePlatform(),
      'test',
      cwd,
      await discover('fails-after-gate'),
      'goal',
      undefined,
      hydrated
    );
    expect((await store.getWorkflowRun(child.id))?.status).toBe('failed');
    expect((await store.getWorkflowRun(parent.id))?.status).toBe('failed');
    expect(
      store.events.filter(
        event =>
          event.workflow_run_id === parent.id &&
          event.step_name === 'sub' &&
          event.event_type === 'node_failed'
      )
    ).toHaveLength(1);
    expect(
      store.events.some(event => event.step_name === 'after' && event.event_type === 'node_started')
    ).toBe(false);
  });

  describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'child source recovery',
    () => {
      it('an admitted child owns its source pause and resumes without replaying parent work', async () => {
        await mkdir(join(cwd, '.archon/scripts'), { recursive: true });
        await writeFile(join(cwd, '.archon/scripts/check.ts'), 'console.log("child done")');
        await writeWorkflow(
          'source-child',
          `name: source-child
description: child
nodes:
  - id: check
    script: check
    runtime: bun
`
        );
        await writeWorkflow(
          'source-parent',
          `name: source-parent
description: parent
nodes:
  - id: before
    prompt: before
  - id: sub
    workflow: source-child
    depends_on: [before]
`
        );
        const store = new InMemoryStore();
        store.releaseRunForUnreadableSource = async (id, release) => {
          const run = store.runs.get(id);
          if (!run || run.status !== 'running') return { released: false };
          run.status = 'paused';
          Object.assign(run.metadata, sourceReleaseMetadata(release, new Date().toISOString()));
          await store.persistWorkflowEvent(sourceReleasedEvent(id, release));
          return { released: true };
        };
        const fail = spyOn(store, 'failWorkflowRun');
        const persist = store.persistWorkflowEvent;
        let locked: string | undefined;
        let inject = true;
        store.persistWorkflowEvent = async event => {
          await persist(event);
          if (inject && event.event_type === 'node_started' && event.step_name === 'check') {
            const child = store.runs.get(event.workflow_run_id);
            if (!child) throw new Error('child not admitted');
            expect(child.status).toBe('running');
            const capture = await resolveRunSourceCapture(child.metadata);
            if (!capture) throw new Error('missing child capture');
            locked = join(capture.anchor.root, 'project/.archon/scripts/check.ts');
            await chmod(locked, 0o000);
          }
        };
        const deps = makeDeps(store);
        const parentWorkflow = await discover('source-parent');
        try {
          await executeWorkflow(
            deps,
            makePlatform(),
            'source-child-test',
            cwd,
            parentWorkflow,
            'goal'
          );
        } finally {
          inject = false;
          if (locked) await chmod(locked, 0o644);
        }
        const parent = [...store.runs.values()].find(run => run.workflow_name === 'source-parent');
        const child = [...store.runs.values()].find(run => run.workflow_name === 'source-child');
        if (!parent || !child) throw new Error('missing parent or child');
        expect(fail).not.toHaveBeenCalled();
        expect(child.status).toBe('paused');
        expect(child.metadata.source_release).toMatchObject({ nodeId: 'check', path: locked });
        expect(parent.status).toBe('paused');
        expect(parent.metadata.approval).toMatchObject({
          type: 'child_workflow',
          nodeId: 'sub',
          childRunId: child.id,
        });
        expect(parent.metadata.source_release).toBeUndefined();
        expect(store.events.filter(event => event.event_type === 'source_released')).toEqual([
          expect.objectContaining({ workflow_run_id: child.id, step_name: 'check' }),
        ]);
        const resumed = await hydrateResumableRun(deps, (await store.getWorkflowRun(child.id))!);
        if (!resumed) throw new Error('child not resumable');
        await executeWorkflow(
          deps,
          makePlatform(),
          'source-child-test',
          cwd,
          await discover('source-child'),
          'goal',
          undefined,
          resumed
        );
        expect(child.status).toBe('completed');
        expect(parent.status).toBe('completed');
        expect(store.runs.size).toBe(2);
        for (const [runId, nodeId] of [
          [parent.id, 'before'],
          [parent.id, 'sub'],
          [child.id, 'check'],
        ]) {
          expect(
            store.events.filter(
              event =>
                event.workflow_run_id === runId &&
                event.step_name === nodeId &&
                event.event_type === 'node_completed'
            )
          ).toHaveLength(1);
        }
        expect(fail).not.toHaveBeenCalled();
      });

      it('a child launch that cannot read the parent source releases the parent', async () => {
        await writeWorkflow(
          'source-child',
          'name: source-child\ndescription: child\nnodes:\n  - id: c\n    prompt: c\n'
        );
        await writeWorkflow(
          'source-parent',
          'name: source-parent\ndescription: parent\nnodes:\n  - id: sub\n    workflow: source-child\n'
        );
        const store = new InMemoryStore();
        const released: Parameters<IWorkflowStore['releaseRunForUnreadableSource']>[1][] = [];
        store.releaseRunForUnreadableSource = async (_id, release) => {
          released.push(release);
          return { released: true };
        };
        const fail = spyOn(store, 'failWorkflowRun');
        const persist = store.persistWorkflowEvent;
        const workflowsDir = join(cwd, '.archon', 'workflows');
        store.persistWorkflowEvent = async event => {
          await persist(event);
          if (event.event_type === 'node_started' && event.step_name === 'sub') {
            await chmod(workflowsDir, 0o000);
          }
        };
        const parentWorkflow = await discover('source-parent');
        try {
          await executeWorkflow(
            makeDeps(store),
            makePlatform(),
            'source-launch-test',
            cwd,
            parentWorkflow,
            'goal'
          );
        } finally {
          await chmod(workflowsDir, 0o755);
        }
        expect(fail).not.toHaveBeenCalled();
        expect(released).toEqual([expect.objectContaining({ nodeId: 'sub' })]);
        expect([...store.runs.values()].map(run => run.workflow_name)).toEqual(['source-parent']);
      });
    }
  );

  it('a resumed parent gives a newly reached child its frozen AI base', async () => {
    await writeWorkflow(
      'frozen-child',
      `name: frozen-child
description: Frozen child policy
nodes:
  - id: ai
    prompt: run child
`
    );
    await writeWorkflow(
      'frozen-parent',
      `name: frozen-parent
description: Frozen parent policy
nodes:
  - id: child
    workflow: frozen-child
`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const workflow = await discover('frozen-parent');
    deps.loadConfig = mock(async () => ({
      assistant: 'codex',
      assistants: { claude: {}, codex: { model: 'gpt-5.6-sol' } },
      commands: {},
      defaults: { loadDefaultWorkflows: false, loadDefaultCommands: false },
    }));
    const launch = await prepareRunAiConfiguration(deps, workflow, cwd);
    const parent = await store.createWorkflowRun({
      workflow_name: workflow.name,
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
      metadata: { ai_configuration: launch.aiConfigurationSnapshot },
    });
    deps.loadConfig = mock(async () => ({
      assistant: 'claude',
      assistants: { claude: { model: 'opus' }, codex: { model: 'changed' } },
      commands: {},
      defaults: { loadDefaultWorkflows: false, loadDefaultCommands: false },
    }));
    const requests: { provider: string; model?: string }[] = [];
    const getProvider = deps.getAgentProvider;
    deps.getAgentProvider = provider => {
      const runtime = getProvider(provider);
      const sendQuery = runtime.sendQuery.bind(runtime);
      runtime.sendQuery = (...args) => {
        requests.push({ provider, model: args[3]?.model });
        return sendQuery(...args);
      };
      return runtime;
    };
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      workflow,
      'goal',
      { conversationId: 'conv-db' },
      { preCreatedRun: await store.resumeWorkflowRun(parent.id), priorCompletedNodes: new Map() }
    );
    expect(result).toMatchObject({ success: true });
    const child = [...store.runs.values()].find(run => run.parent_run_id === parent.id);
    expect(child?.metadata.ai_configuration).toEqual(launch.aiConfigurationSnapshot);
    expect(requests).toEqual([{ provider: 'codex', model: 'gpt-5.6-sol' }]);
  });

  it('an existing child resumes with its own recorded policy before the parent policy', async () => {
    await writeWorkflow(
      'owned-child',
      `name: owned-child
description: Own recorded policy
nodes:
  - id: ai
    prompt: resume child
`
    );
    await writeWorkflow(
      'owned-parent',
      `name: owned-parent
description: Resume an existing child
nodes:
  - id: child
    workflow: owned-child
`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const workflow = await discover('owned-parent');
    const parentPrepared = await prepareRunAiConfiguration(deps, workflow, cwd);
    const parent = await store.createWorkflowRun({
      workflow_name: workflow.name,
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
      metadata: { ai_configuration: parentPrepared.aiConfigurationSnapshot },
    });
    deps.loadConfig = mock(async () => ({
      assistant: 'codex',
      assistants: { claude: {}, codex: { model: 'child-model' } },
      commands: {},
      defaults: { loadDefaultWorkflows: false, loadDefaultCommands: false },
    }));
    const childPrepared = await prepareRunAiConfiguration(deps, await discover('owned-child'), cwd);
    const child = await store.createWorkflowRun({
      workflow_name: 'owned-child',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
      parent_run_id: parent.id,
      metadata: {
        parent_node_id: 'child',
        ai_configuration: childPrepared.aiConfigurationSnapshot,
      },
    });
    await store.failWorkflowRun(child.id, 'interrupted');
    deps.loadConfig = mock(async () => ({
      assistant: 'claude',
      assistants: { claude: { model: 'current-model' }, codex: {} },
      commands: {},
      defaults: { loadDefaultWorkflows: false, loadDefaultCommands: false },
    }));
    const queries: { provider: string; model?: string }[] = [];
    const getProvider = deps.getAgentProvider;
    deps.getAgentProvider = provider => {
      const runtime = getProvider(provider);
      const sendQuery = runtime.sendQuery.bind(runtime);
      runtime.sendQuery = (...args) => {
        queries.push({ provider, model: args[3]?.model });
        return sendQuery(...args);
      };
      return runtime;
    };
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      workflow,
      'goal',
      { conversationId: 'conv-db' },
      { preCreatedRun: await store.resumeWorkflowRun(parent.id), priorCompletedNodes: new Map() }
    );
    expect(result).toMatchObject({ success: true });
    expect(queries).toEqual([{ provider: 'codex', model: 'child-model' }]);
    expect([...store.runs.values()].filter(run => run.parent_run_id === parent.id)).toHaveLength(1);
    expect((await store.getWorkflowRun(child.id))?.metadata.ai_configuration).toEqual(
      childPrepared.aiConfigurationSnapshot
    );
  });

  const origins = [
    undefined,
    { conversationId: 'chat-db', parentConversationId: 'parent-chat-db', userId: 'creator' },
  ] satisfies (WorkflowRunOrigin | undefined)[];

  it.each(origins)('inherits optional origin through real child execution', async origin => {
    await writeWorkflow(
      'origin-child',
      `
name: origin-child
description: child
nodes:
  - id: work
    bash: 'echo child'
`
    );
    await writeWorkflow(
      'origin-parent',
      `
name: origin-parent
description: parent
persist_sessions: true
nodes:
  - id: child
    workflow: origin-child
  - id: finish
    prompt: finish
    depends_on: [child]
`
    );
    const store = new InMemoryStore();
    const sessionReads = mock<IWorkflowStore['listWorkflowNodeSessions']>(async () => []);
    store.listWorkflowNodeSessions = sessionReads;
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'run-correlation',
      cwd,
      await discover('origin-parent'),
      'goal',
      origin
    );
    expect(result.success).toBe(true);
    expect(store.runs.size).toBe(2);
    for (const run of store.runs.values()) {
      expect(run.origin).toEqual(origin ?? null);
      expect(run.conversation_id).toBe(origin?.conversationId ?? null);
      expect(run.user_id).toBe(origin?.userId ?? null);
    }
    const { artifactsRoot } = realArchonPaths.getProjectStoragePaths({ kind: 'cwd', cwd });
    if (origin) {
      expect(sessionReads).toHaveBeenCalledWith({
        workflow_name: 'origin-parent',
        scope_key: origin.parentConversationId,
      });
      expect(
        existsSync(
          realArchonPaths.getScopeArtifactsPath(
            artifactsRoot,
            'origin-parent',
            origin.parentConversationId
          )
        )
      ).toBe(true);
    } else {
      expect(sessionReads).not.toHaveBeenCalled();
      expect(existsSync(join(artifactsRoot, 'scopes'))).toBe(false);
    }
  });

  it('runs, pauses and resumes the real engine without conversation or user records', async () => {
    await writeWorkflow(
      'originless-resume',
      `
name: originless-resume
description: local approval lifecycle
persist_sessions: true
nodes:
  - id: before
    bash: 'echo before'
  - id: gate
    approval:
      message: approve
    depends_on: [before]
  - id: after
    bash: 'echo after'
    depends_on: [gate]
`
    );
    const store = new InMemoryStore();
    const engine = new InProcessWorkflowEngine(makeDeps(store));
    const platform = makePlatform();
    const result = await engine.submit({
      platform,
      conversationId: 'local-run',
      cwd,
      workflow: await discover('originless-resume'),
      userMessage: 'goal',
    });
    expect(result).toMatchObject({ success: true, paused: true });
    const paused = [...store.runs.values()][0];
    if (!paused) throw new Error('expected paused run');
    expect(paused.origin).toBeNull();
    expect(paused.conversation_id).toBeNull();
    expect(paused.user_id).toBeNull();
    store.approveGate(paused.id);
    const admission = await engine.resume({
      platform,
      conversationId: 'local-run',
      cwd,
      userMessage: 'goal',
      run: paused,
      legacyWorkflow: await discover('originless-resume'),
    });
    if (!admission.accepted) throw new Error('expected resume admission');
    expect(await admission.settled).toMatchObject({ success: true, workflowRunId: paused.id });
    expect(store.runs.size).toBe(1);
    expect((await store.getWorkflowRun(paused.id))?.origin).toBeNull();
    for (const step of ['before', 'after']) {
      expect(
        store.events.filter(
          event => event.event_type === 'node_completed' && event.step_name === step
        )
      ).toHaveLength(1);
    }
  });

  it("pins a pre-change run's source settings on its row at the first resume", async () => {
    // A row written before `source_config` lived beside the digest carries only the
    // digest. The manifest holding the settings is outside that digest, so until they are
    // pinned any node could rewrite them between resumes without detection.
    await writeWorkflow(
      'legacy-resume',
      `
name: legacy-resume
description: resumes a run recorded before source settings were pinned
nodes:
  - id: work
    bash: "echo resumed"
`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const workflow = await discover('legacy-resume');
    const sourceConfig = {
      load_default_workflows: false,
      load_default_commands: false,
      command_folder: 'team-commands',
    };
    const capture = await captureWorkflowSource({
      sourceRoot: cwd,
      captureRoot: join(cwd, 'home', 'workflow-source', 'runs', 'legacy'),
      sourceConfig,
    });
    const run = await store.createWorkflowRun({
      workflow_name: 'legacy-resume',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    await store.updateWorkflowRun(run.id, {
      metadata: {
        workflow_source: {
          version: 1,
          root: capture.anchor.root,
          origin: cwd,
          captured_at: capture.manifest.captured_at,
          digest: capture.manifest.digest,
          file_count: capture.manifest.file_count,
          byte_count: capture.manifest.byte_count,
        },
      },
    });

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      workflow,
      'goal',
      { conversationId: 'conv-db' },
      { preCreatedRun: await store.resumeWorkflowRun(run.id) }
    );
    expect(result.success).toBe(true);

    const row = (await store.getWorkflowRun(run.id))!;
    const record = row.metadata.workflow_source as { source_config?: unknown };
    expect(record.source_config).toEqual(sourceConfig);

    // The pin holds: the manifest is no longer the authority, so editing it is drift.
    const manifestPath = join(capture.anchor.root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        source_config: { ...sourceConfig, load_default_commands: true },
      })
    );
    await expect(resolveRunSourceCapture(row.metadata)).rejects.toThrow(
      'different resolution settings'
    );
  });

  // `hydrated` resumes from the completed-node snapshot; `bare` re-enters the existing run
  // with no snapshot, the way a failed child is re-driven. Both are resumes.
  it.each(['hydrated', 'bare'] as const)(
    "marks a %s resume's boundary in its transcript, distinct from the original start",
    async resumeForm => {
      await writeWorkflow(
        'resume-boundary',
        `
name: resume-boundary
description: fails on the first drive, succeeds on the resume
nodes:
  - id: first
    bash: "echo first"
  - id: flaky
    bash: "if [ -f resumed.marker ]; then echo ok; else touch resumed.marker; exit 1; fi"
    depends_on: [first]
`
      );
      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const workflow = await discover('resume-boundary');

      const r1 = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, workflow, 'goal', {
        conversationId: 'conv-db',
      });
      expect(r1.success).toBe(false);
      const run = [...store.runs.values()].find(r => r.workflow_name === 'resume-boundary')!;
      expect(run.status).toBe('failed');

      telemetryResumeFlags.length = 0;
      const resumeOpts =
        resumeForm === 'hydrated'
          ? await hydrateResumableRun(deps, (await store.getWorkflowRun(run.id))!)
          : { preCreatedRun: await store.resumeWorkflowRun(run.id) };
      expect(resumeOpts).not.toBeNull();
      const r2 = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-plat',
        cwd,
        workflow,
        'goal',
        { conversationId: 'conv-db' },
        { ...resumeOpts! }
      );
      expect(r2.success).toBe(true);
      // Telemetry categorizes the same execution the same way the transcript does.
      expect(telemetryResumeFlags).toEqual([{ workflowName: 'resume-boundary', isResume: true }]);

      const row = (await store.getWorkflowRun(run.id))!;
      const transcript = (
        await readFile(join(row.output_root!, 'logs', `${run.id}.jsonl`), 'utf-8')
      )
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { type: string; workflow_name?: string });
      const types = transcript.map(r => r.type);
      // The original start stays the first row and is written once; the resume writes its
      // own boundary row after the first attempt's failure, before the second attempt's work.
      expect(types.filter(t => t === 'workflow_start')).toHaveLength(1);
      expect(types[0]).toBe('workflow_start');
      expect(types.filter(t => t === 'workflow_resume')).toHaveLength(1);
      const resumeAt = types.indexOf('workflow_resume');
      expect(types.indexOf('workflow_error')).toBeLessThan(resumeAt);
      expect(types.lastIndexOf('workflow_complete')).toBeGreaterThan(resumeAt);
      expect(transcript[resumeAt]).toMatchObject({ workflow_name: 'resume-boundary' });
    }
  );

  it('runs a gateless child synchronously, threads output + cost + tokens, links parent_run_id', async () => {
    await writeWorkflow(
      'child-plain',
      `
name: child-plain
description: child with no gate
nodes:
  - id: work
    prompt: "do the work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-plain',
      `
name: parent-plain
description: parent that composes child-plain
nodes:
  - id: plan
    prompt: "plan"
  - id: sub
    workflow: child-plain
    input: "$plan.output"
    depends_on: [plan]
  - id: after
    prompt: "downstream reads $sub.output"
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-plain');

    // Pin the double-fire guard: on the synchronous path the child's terminal
    // hook (maybeResumeParentRun) fires while the parent is still 'running' on
    // the call stack — the guard must make it a no-op, so resumeWorkflowRun is
    // never invoked for anything in this run tree.
    const resumeCalls: string[] = [];
    const realResume = store.resumeWorkflowRun.bind(store);
    store.resumeWorkflowRun = (id: string) => {
      resumeCalls.push(id);
      return realResume(id);
    };

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'the-goal',
      { conversationId: 'conv-db' }
    );

    expect(result.success).toBe(true);
    // Guard held: no resume of the parent (or anything else) mid-flight, and no
    // node ran twice — a regressed guard would recursively re-enter the parent
    // while its own call frame is live (duplicate AI calls / duplicate events).
    expect(resumeCalls).toEqual([]);
    const completedSteps = store.events
      .filter(e => e.event_type === 'node_completed')
      .map(e => e.step_name);
    expect(new Set(completedSteps).size).toBe(completedSteps.length);
    // Parent completed.
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-plain');
    expect(parentRun?.status).toBe('completed');
    // The parent is a hand-built programmatic definition with no prepared capture.
    expect(parentRun?.metadata.workflow_source).toBeUndefined();
    // Child row exists, linked to the parent + node.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-plain');
    expect(child).toBeDefined();
    expect(child?.parent_run_id).toBe(parentRun?.id);
    expect((child?.metadata as Record<string, unknown>).parent_node_id).toBe('sub');
    expect(child?.status).toBe('completed');
    expect(
      (child?.metadata.workflow_source as { source_config?: unknown } | undefined)?.source_config
    ).toEqual({ load_default_workflows: false, load_default_commands: false });
    // Child persisted its terminal summary + cost for the parent to read back.
    expect((child?.metadata as Record<string, unknown>).summary).toBe('ai-output');
    expect((child?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.01, 5);
    expect((child?.metadata as Record<string, unknown>).total_tokens_in).toBe(7);
    expect((child?.metadata as Record<string, unknown>).total_cache_read_tokens).toBe(5);
    expect((child?.metadata as Record<string, unknown>).total_cache_write_tokens).toBe(0);
    expect((child?.metadata as Record<string, unknown>).total_tokens_out).toBe(3);
    // The sub node wrote node_completed with the child's output (threaded to $sub.output).
    const subCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'sub'
    );
    expect(subCompleted?.data?.node_output).toBe('ai-output');
    // ...and with the child's rolled-up usage. Tokens must ride along with cost:
    // they are the only usage axis every provider reports (#2333), and the child's
    // own per-node rows are filed under a different workflow_run_id, so this cannot
    // double count within the parent's stream.
    expect(subCompleted?.data?.cost_usd).toBeCloseTo(0.01, 5);
    expect(subCompleted?.data?.tokens).toEqual({
      input: 7,
      output: 3,
      cacheRead: 5,
      cacheWrite: 0,
    });
    // Child conversation is shared with the parent.
    expect(child?.conversation_id).toBe('conv-db');
  });

  it.each([false, true])(
    'retains paid child usage through terminal write failure (unknown tokens=%p)',
    async unknownTokens => {
      await writeWorkflow(
        'child-terminal-write',
        `
name: child-terminal-write
description: child whose completion write fails
nodes:
  - id: work
    prompt: "work"
`
      );
      await writeWorkflow(
        'parent-terminal-write',
        `
name: parent-terminal-write
description: parent that invokes the child
nodes:
  - id: sub
    workflow: child-terminal-write
`
      );

      const store = new InMemoryStore();
      const completeWorkflowRun = store.completeWorkflowRun.bind(store);
      const failWorkflowRun = store.failWorkflowRun.bind(store);
      const parentFailureWrites: string[] = [];
      store.completeWorkflowRun = async (runId, completion, metadata) => {
        if (store.runs.get(runId)?.workflow_name === 'child-terminal-write') {
          if (unknownTokens) {
            await store.updateWorkflowRun(runId, { metadata: { total_tokens_unknown: true } });
            const parent = [...store.runs.values()].find(
              run => run.workflow_name === 'parent-terminal-write'
            )!;
            await store.updateWorkflowRun(parent.id, {
              metadata: {
                total_tokens_in: 999,
                total_tokens_out: 999,
                total_cache_read_tokens: 999,
                total_cache_write_tokens: 999,
              },
            });
          }
          throw new Error('child terminal write failed');
        }
        return completeWorkflowRun(runId, completion, metadata);
      };
      store.failWorkflowRun = (runId, error) => {
        if (store.runs.get(runId)?.workflow_name === 'parent-terminal-write') {
          parentFailureWrites.push(error);
        }
        return failWorkflowRun(runId, error);
      };

      await expect(
        executeWorkflow(
          makeDeps(store),
          makePlatform(),
          'conv-plat',
          cwd,
          await discover('parent-terminal-write'),
          'goal',
          { conversationId: 'conv-db' }
        )
      ).rejects.toThrow('child terminal write failed');

      expect(parentFailureWrites).toEqual([]);
      const parent = [...store.runs.values()].find(
        run => run.workflow_name === 'parent-terminal-write'
      )!;
      expect(parent.metadata).toMatchObject({ total_cost_usd: 0.01 });
      expect(parent.metadata).toMatchObject(
        unknownTokens
          ? {
              total_tokens_unknown: true,
              total_tokens_in: null,
              total_tokens_out: null,
              total_cache_read_tokens: null,
              total_cache_write_tokens: null,
            }
          : {
              total_tokens_in: 7,
              total_tokens_out: 3,
              total_cache_read_tokens: 5,
              total_cache_write_tokens: 0,
            }
      );
    }
  );

  it('propagates a child terminal write failure through a fan-out node', async () => {
    await writeWorkflow(
      'fan-child-terminal-write',
      `
name: fan-child-terminal-write
description: read-only child whose completion write fails
mutates_checkout: false
nodes:
  - id: work
    prompt: "work"
`
    );
    await writeWorkflow(
      'fan-parent-terminal-write',
      `
name: fan-parent-terminal-write
description: parent that fans out to the child
nodes:
  - id: work
    workflow: fan-child-terminal-write
    mutates_checkout: false
    fan_out:
      items: '["one"]'
`
    );

    const store = new InMemoryStore();
    const completeWorkflowRun = store.completeWorkflowRun.bind(store);
    store.completeWorkflowRun = (runId, completion, metadata) => {
      if (store.runs.get(runId)?.workflow_name === 'fan-child-terminal-write') {
        return Promise.reject(new Error('fan-out child terminal write failed'));
      }
      return completeWorkflowRun(runId, completion, metadata);
    };

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-plat',
        cwd,
        await discover('fan-parent-terminal-write'),
        'goal',
        { conversationId: 'conv-db' }
      )
    ).rejects.toThrow('fan-out child terminal write failed');
    const parent = [...store.runs.values()].find(
      run => run.workflow_name === 'fan-parent-terminal-write'
    )!;
    expect(parent.metadata).toMatchObject({
      total_cost_usd: 0.01,
      total_tokens_in: 7,
      total_tokens_out: 3,
      total_cache_read_tokens: 5,
      total_cache_write_tokens: 0,
    });
  });

  it('propagates sparse model bindings into a child run and its effective profile', async () => {
    await writeWorkflow(
      'child-model-binding',
      `
name: child-model-binding
description: child using the large tier
nodes:
  - id: child-work
    prompt: "child work"
    model: large
`
    );
    await writeWorkflow(
      'parent-model-binding',
      `
name: parent-model-binding
description: parent composing a child with the same run binding
nodes:
  - id: sub
    workflow: child-model-binding
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-model-binding');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      {
        modelOverrideLayer: {
          kind: 'raw',
          overrides: { tiers: { large: 'codex/gpt-5.6-sol' } },
        },
      }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(
      run => run.workflow_name === 'parent-model-binding'
    );
    const childRun = [...store.runs.values()].find(
      run => run.workflow_name === 'child-model-binding'
    );
    expect(childRun?.parent_run_id).toBe(parentRun?.id);
    expect(childRun?.metadata.model_bindings).toMatchObject({
      overrides: {
        tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
      },
      effective: {
        aliases: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
      },
    });
  });

  it('propagates a sparse run config into a child and gives it durable attribution', async () => {
    await writeWorkflow(
      'child-run-config',
      `
name: child-run-config
description: child using the large tier
nodes:
  - id: child-work
    prompt: "child work"
    model: large
`
    );
    await writeWorkflow(
      'parent-run-config',
      `
name: parent-run-config
description: parent composing a child with the same run config
nodes:
  - id: sub
    workflow: child-run-config
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-run-config');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      {
        runConfig: {
          source: { kind: 'cli', label: 'config.minimax.yaml' },
          layer: {
            tiers: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
            envVars: { BENCH_MODE: '1' },
          },
        },
      }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(
      run => run.workflow_name === 'parent-run-config'
    );
    const childRun = [...store.runs.values()].find(run => run.workflow_name === 'child-run-config');
    expect(childRun?.parent_run_id).toBe(parentRun?.id);
    expect(childRun?.metadata.run_config).toMatchObject({
      source: { kind: 'cli', label: 'config.minimax.yaml' },
      keys: ['env.BENCH_MODE', 'tiers.large'],
    });
    expect(childRun?.metadata.model_bindings).toMatchObject({
      effective: {
        aliases: { large: { provider: 'codex', model: 'gpt-5.6-sol' } },
      },
    });
  });

  it('blocked-on-child notice spells the approve command for the surface; the persisted gate stays neutral', async () => {
    await writeWorkflow(
      'child-gated-spelling',
      `
name: child-gated-spelling
description: child with an approval gate
nodes:
  - id: review-gate
    approval:
      message: "review the sub-run"
`
    );
    await writeWorkflow(
      'parent-gated-spelling',
      `
name: parent-gated-spelling
description: parent composing a gated child
nodes:
  - id: sub
    workflow: child-gated-spelling
`
    );

    const store = new InMemoryStore();
    const platform = {
      ...makePlatform(),
      // Mirrors the Slack adapter: its registered slash command is `/archon-workflow`.
      formatWorkflowCommand: (command: string) => `/archon-workflow ${command}`,
    };
    await executeWorkflow(
      makeDeps(store),
      platform,
      'conv-plat',
      cwd,
      await discover('parent-gated-spelling'),
      'goal',
      { conversationId: 'conv-db' }
    );

    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'parent-gated-spelling'
    );
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-gated-spelling');
    const sent = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(call => (call as unknown[])[1] as string)
      .join('\n');
    expect(sent).toContain(`Approve it by run id: \`/archon-workflow approve ${child!.id}\``);
    expect(sent.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    expect(parentRun?.metadata.approval).toMatchObject({
      type: 'child_workflow',
      nodeId: 'sub',
      childRunId: child!.id,
      pauseId: expect.any(String),
    });
    expect((parentRun?.metadata.approval as { message: string }).message).not.toContain(
      '/workflow '
    );
    expect((parentRun?.metadata.approval as { message: string }).message).not.toContain(
      '/archon-workflow '
    );
    expect((parentRun?.metadata.approval as { message: string }).message).not.toContain(
      'archon workflow '
    );
  });

  it('child gate → parent pauses blocked-on-child → approve child → parent auto-resumes → output threads', async () => {
    await writeWorkflow(
      'child-gated',
      `
name: child-gated
description: child with an approval gate
nodes:
  - id: implement
    prompt: "implement $ARGUMENTS"
  - id: review-gate
    approval:
      message: "review the sub-run"
    depends_on: [implement]
  - id: qa-summary
    prompt: "summarize"
    depends_on: [review-gate]
`
    );
    await writeWorkflow(
      'parent-gated',
      `
name: parent-gated
description: parent composing a gated child
nodes:
  - id: plan
    prompt: "plan"
  - id: sub
    workflow: child-gated
    input: "$plan.output"
    depends_on: [plan]
  - id: after
    prompt: "downstream: $sub.output"
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const pause = store.pauseWorkflowRun;
    const childBlockEvents: unknown[] = [];
    store.pauseWorkflowRun = (id, approval, extra, event) => {
      if (approval.type === 'child_workflow') childBlockEvents.push(event);
      return pause(id, approval, extra, event);
    };
    const deps = makeDeps(store);
    const parent = await discover('parent-gated');

    // First drive: parent runs, child pauses at its gate, parent pauses on child.
    const r1 = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });
    expect(r1.success && 'paused' in r1 && r1.paused).toBe(true);

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-gated');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-gated');
    expect(parentRun?.status).toBe('paused');
    expect(child?.status).toBe('paused');
    // Parent pause is a child_workflow gate pointing at the child; NO node_completed
    // was written for the sub node (so it re-runs on resume).
    const parentApproval = parentRun?.metadata.approval as Record<string, unknown>;
    expect(parentApproval.type).toBe('child_workflow');
    expect(parentApproval.childRunId).toBe(child?.id);
    expect(store.events.some(e => e.event_type === 'node_completed' && e.step_name === 'sub')).toBe(
      false
    );
    // The blocked-on-child pause commits its node_suspended with the pause, once.
    expect(childBlockEvents).toEqual([
      expect.objectContaining({ event_type: 'node_suspended', step_name: 'sub' }),
    ]);
    expect(
      store.events.filter(
        e =>
          e.workflow_run_id === parentRun?.id &&
          e.event_type === 'node_suspended' &&
          e.step_name === 'sub'
      )
    ).toHaveLength(1);

    // Approve the CHILD by run id, then resume it — the child's completion fires the
    // parent auto-resume hook in-process.
    store.approveGate(child!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child!.id))!);
    expect(hydrated).not.toBeNull();
    const childWf = await discover('child-gated');
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      childWf,
      child!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    // Child completed; parent auto-resumed and completed, threading the child output.
    expect((await store.getWorkflowRun(child!.id))?.status).toBe('completed');
    const finalParent = await store.getWorkflowRun(parentRun!.id);
    expect(finalParent?.status).toBe('completed');
    const subCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'sub'
    );
    expect(subCompleted?.data?.node_output).toBe('ai-output');
  });

  it('concurrent child runs present independent gates and resume the parent in either decision order', async () => {
    await writeWorkflow(
      'independent-child',
      `
name: independent-child
description: Child approval
mutates_checkout: false
nodes:
  - id: review
    approval:
      message: Review this child
  - id: done
    depends_on: [review]
    prompt: Done
`
    );
    await writeWorkflow(
      'independent-parent',
      `
name: independent-parent
description: Independent children
mutates_checkout: false
nodes:
  - id: first
    workflow: independent-child
  - id: second
    workflow: independent-child
`
    );
    for (const activeFirst of [false, true]) {
      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const platform = makePlatform();
      await executeWorkflow(
        deps,
        platform,
        'conv-plat',
        cwd,
        await discover('independent-parent'),
        'goal',
        { conversationId: 'conv-db' }
      );
      const parent = [...store.runs.values()].find(
        run => run.workflow_name === 'independent-parent'
      )!;
      const children = await store.findChildRuns(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map(child => child.status)).toEqual(['paused', 'paused']);
      const prompts = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
        .map(call => call[1] as string)
        .filter(message => message.includes('**Approval required**'));
      expect(prompts).toHaveLength(2);
      for (const child of children)
        expect(prompts.some(message => message.includes(`approve ${child.id}`))).toBe(true);
      const approval = parent.metadata.approval;
      if (!isApprovalContext(approval)) throw new Error('Missing parent block');
      const active = children.find(child => child.id === approval.childRunId)!;
      const other = children.find(child => child.id !== approval.childRunId)!;
      const ordered = activeFirst ? [active, other] : [other, active];
      for (const [index, child] of ordered.entries()) {
        store.approveGate(child.id);
        const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child.id))!);
        expect(hydrated).not.toBeNull();
        await executeWorkflow(
          deps,
          platform,
          'conv-plat',
          cwd,
          await discover('independent-child'),
          child.user_message,
          { conversationId: 'conv-db' },
          { ...hydrated! }
        );
        expect((await store.getWorkflowRun(child.id))?.status).toBe('completed');
        expect((await store.getWorkflowRun(parent.id))?.status).toBe(
          index === 0 ? 'paused' : 'completed'
        );
      }
      expect(
        store.events
          .filter(
            event => event.workflow_run_id === parent.id && event.event_type === 'node_completed'
          )
          .map(event => event.step_name)
          .sort()
      ).toEqual(['first', 'second']);
    }
  });

  it('a throw during the parent auto-resume pass lands the parent in failed, never wedged at running', async () => {
    await writeWorkflow(
      'child-gated',
      `
name: child-gated
description: child with an approval gate
nodes:
  - id: implement
    prompt: "implement $ARGUMENTS"
  - id: review-gate
    approval:
      message: "review the sub-run"
    depends_on: [implement]
`
    );
    await writeWorkflow(
      'parent-gated',
      `
name: parent-gated
description: parent composing a gated child
nodes:
  - id: sub
    workflow: child-gated
    input: "goal"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-gated');
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-gated');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-gated');
    expect(parentRun?.status).toBe('paused');

    // Sabotage the auto-resume pass: the resumed parent carries a codebase_id, so
    // executeWorkflow's early setup (before its failWorkflowRun catch-all) calls
    // getCodebaseEnvVars — make it throw. The child's own resume drive below does
    // not pass a codebaseId, so only the parent's pass hits the mine.
    parentRun!.codebase_id = 'cb-1';
    store.getCodebaseEnvVars = () => Promise.reject(new Error('env lookup exploded'));

    store.approveGate(child!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child!.id))!);
    const childWf = await discover('child-gated');
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      childWf,
      child!.user_message,
      { conversationId: 'conv-db' },
      {
        ...hydrated!,
      }
    );

    // Child completed normally; its result is untouched by the parent's failure.
    expect((await store.getWorkflowRun(child!.id))?.status).toBe('completed');
    // The parent must land in 'failed' (resumable) — NOT stuck at 'running',
    // which resumeWorkflow refuses and only a destructive abandon could clear.
    const finalParent = await store.getWorkflowRun(parentRun!.id);
    expect(finalParent?.status).toBe('failed');
    expect(String(finalParent?.metadata.error)).toContain('Auto-resume after sub-run failed');
  });

  it('surfaces a rejected parent terminal write after the child completes', async () => {
    await writeWorkflow(
      'child-gated',
      `
name: child-gated
description: child with an approval gate
nodes:
  - id: implement
    prompt: "implement $ARGUMENTS"
  - id: review-gate
    approval:
      message: "review the sub-run"
    depends_on: [implement]
`
    );
    await writeWorkflow(
      'parent-gated',
      `
name: parent-gated
description: parent composing a gated child
nodes:
  - id: sub
    workflow: child-gated
    input: "goal"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-gated');
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-gated');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-gated');
    expect(parentRun?.status).toBe('paused');

    parentRun!.codebase_id = 'cb-1';
    store.getCodebaseEnvVars = () => Promise.reject(new Error('env lookup exploded'));
    const failWorkflowRun = store.failWorkflowRun.bind(store);
    const parentFailureWrites: string[] = [];
    store.failWorkflowRun = (runId, error) => {
      if (runId === parentRun!.id) {
        parentFailureWrites.push(error);
        return Promise.reject(new Error('parent terminal write failed'));
      }
      return failWorkflowRun(runId, error);
    };

    store.approveGate(child!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(child!.id))!);
    const childWf = await discover('child-gated');
    await expect(
      executeWorkflow(
        deps,
        makePlatform(),
        'conv-plat',
        cwd,
        childWf,
        child!.user_message,
        { conversationId: 'conv-db' },
        { ...hydrated! }
      )
    ).rejects.toThrow('parent terminal write failed');

    expect((await store.getWorkflowRun(child!.id))?.status).toBe('completed');
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('running');
    expect(parentFailureWrites).toHaveLength(1);
  });

  it('child failure fails the sub node and the parent run', async () => {
    await writeWorkflow(
      'child-fail',
      `
name: child-fail
description: child that fails
nodes:
  - id: boom
    bash: "exit 3"
`
    );
    await writeWorkflow(
      'parent-fail',
      `
name: parent-fail
description: parent composing a failing child
nodes:
  - id: sub
    workflow: child-fail
    input: "x"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-fail');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-fail');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-fail');
    expect(child?.status).toBe('failed');
    expect(parentRun?.status).toBe('failed');
  });

  it('rejects a self-referential sub-run at runtime (cycle guard)', async () => {
    await writeWorkflow(
      'selfie',
      `
name: selfie
description: names itself as a sub-run
nodes:
  - id: sub
    workflow: selfie
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('selfie');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'selfie');
    expect(parentRun?.status).toBe('failed');
    // No child run was created for the cycle.
    expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
  });

  it('rejects an INDIRECT cycle (A → B → A) at runtime', async () => {
    await writeWorkflow(
      'cycle-a',
      `
name: cycle-a
description: composes cycle-b
nodes:
  - id: sub
    workflow: cycle-b
`
    );
    await writeWorkflow(
      'cycle-b',
      `
name: cycle-b
description: composes cycle-a (closing the loop)
nodes:
  - id: sub
    workflow: cycle-a
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const a = await discover('cycle-a');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, a, 'g', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    // B was spawned as A's child, then B's own sub node hit the ancestry guard.
    const bRun = [...store.runs.values()].find(r => r.workflow_name === 'cycle-b');
    expect(bRun?.status).toBe('failed');
    expect(String(bRun?.metadata.error)).toMatch(/cycle/i);
    // No third-level run (a second cycle-a) was ever created.
    expect([...store.runs.values()].filter(r => r.workflow_name === 'cycle-a')).toHaveLength(1);
  });

  it('enforces the sub-run depth cap', async () => {
    // deep-1 → deep-2 → … → deep-7: the cap fires when a run whose ancestry is
    // already CHILD_WORKFLOW_DEPTH_CAP (5) deep tries to spawn the next child —
    // i.e. deep-6 (ancestry deep-1..deep-5) attempting to spawn deep-7.
    for (let i = 1; i <= 7; i++) {
      const body =
        i < 7
          ? `  - id: sub\n    workflow: deep-${String(i + 1)}\n`
          : `  - id: leaf\n    prompt: "bottom"\n`;
      await writeWorkflow(
        `deep-${String(i)}`,
        `\nname: deep-${String(i)}\ndescription: depth chain link ${String(i)}\nnodes:\n${body}`
      );
    }

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const top = await discover('deep-1');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, top, 'g', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    // The cap counts the full ancestor chain INCLUDING the spawning run itself,
    // so a cap of 5 allows at most 5 nested runs: deep-5 (chain length 5) is
    // refused when it tries to spawn deep-6. The refusal fails deep-5's node and
    // propagates up the whole chain.
    const runNames = [...store.runs.values()].map(r => r.workflow_name);
    expect(runNames).toContain('deep-5');
    expect(runNames).not.toContain('deep-6');
    expect([...store.runs.values()].every(r => r.status === 'failed')).toBe(true);
  });

  it('resume-through-parent re-drives a failed child once; a cancelled child fails the node', async () => {
    // Child fails on the first pass, succeeds on the second (marker file).
    await writeWorkflow(
      'child-flaky',
      `
name: child-flaky
description: fails once then succeeds
nodes:
  - id: attempt
    bash: "test -f flaky-marker && echo recovered || { touch flaky-marker; exit 3; }"
`
    );
    await writeWorkflow(
      'parent-recover',
      `
name: parent-recover
description: parent that recovers a flaky child on resume
nodes:
  - id: sub
    workflow: child-flaky
    input: "x"
  - id: after
    prompt: "downstream: $sub.output"
    depends_on: [sub]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-recover');

    // First drive: child fails → node fails → parent fails.
    const r1 = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-recover');
    const child1 = [...store.runs.values()].find(r => r.workflow_name === 'child-flaky');
    expect(parentRun?.status).toBe('failed');
    expect(child1?.status).toBe('failed');

    // Resume the PARENT: re-entry finds the failed child and re-drives it once
    // (resumeChild), the marker now exists so the child completes, and the
    // output threads through to the downstream node. A failed parent with zero
    // completed nodes hydrates to null — mirror the CLI's fallback: flip it back
    // to running and re-run from the top under the SAME run id.
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun!.id))!);
    const resumeOpts = hydrated ?? {
      preCreatedRun: await store.resumeWorkflowRun(parentRun!.id),
    };
    const r2 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { ...resumeOpts }
    );
    expect(r2.success).toBe(true);
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('completed');
    // Same child ROW was re-driven — no second child-flaky run was created.
    const flakyRuns = [...store.runs.values()].filter(r => r.workflow_name === 'child-flaky');
    expect(flakyRuns).toHaveLength(1);
    expect(flakyRuns[0].status).toBe('completed');
    const subCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'sub'
    );
    expect(String(subCompleted?.data?.node_output)).toContain('recovered');

    // Separately: a child cancelled out-of-band fails the node on re-entry.
    await writeWorkflow(
      'parent-cancelled',
      `
name: parent-cancelled
description: parent whose child gets cancelled out-of-band
nodes:
  - id: sub
    workflow: child-flaky
    input: "x"
`
    );
    const store2 = new InMemoryStore();
    const deps2 = makeDeps(store2);
    const parent2 = await discover('parent-cancelled');
    // Fail the child's first pass again for this fresh store: remove the marker.
    await rm(join(cwd, 'flaky-marker'), { force: true });
    const p2r1 = await executeWorkflow(deps2, makePlatform(), 'conv-plat', cwd, parent2, 'goal', {
      conversationId: 'conv-db',
    });
    expect(p2r1.success).toBe(false);
    const child2 = [...store2.runs.values()].find(r => r.workflow_name === 'child-flaky');
    // Out-of-band cancel (e.g. a direct abandon of the child).
    await store2.cancelWorkflowRun(child2!.id);
    const parentRun2 = [...store2.runs.values()].find(r => r.workflow_name === 'parent-cancelled');
    const hydrated2 = await hydrateResumableRun(
      deps2,
      (await store2.getWorkflowRun(parentRun2!.id))!
    );
    const resumeOpts2 = hydrated2 ?? {
      preCreatedRun: await store2.resumeWorkflowRun(parentRun2!.id),
    };
    const p2r2 = await executeWorkflow(
      deps2,
      makePlatform(),
      'conv-plat',
      cwd,
      parent2,
      'goal',
      { conversationId: 'conv-db' },
      { ...resumeOpts2 }
    );
    expect(p2r2.success).toBe(false);
    // The cancelled child was NOT re-driven; the node failed with the cancel message.
    expect((await store2.getWorkflowRun(child2!.id))?.status).toBe('cancelled');
    expect((await store2.getWorkflowRun(parentRun2!.id))?.status).toBe('failed');
    expect(String((await store2.getWorkflowRun(parentRun2!.id))?.metadata.error)).toMatch(
      /cancelled/i
    );
  });

  it.each(['configuration', 'credential'] as const)(
    'fails child %s preflight before creating a child row or isolation',
    async failure => {
      await writeWorkflow(
        'child-plain',
        `name: child-plain
description: child
nodes:
  - id: work
    prompt: work
    provider: codex
    model: gpt-5.4
`
      );
      await writeWorkflow(
        'parent-plain',
        `name: parent-plain
description: parent
nodes:
  - id: sub
    workflow: child-plain
    isolation: worktree
`
      );
      const store = new InMemoryStore();
      let envCalls = 0;
      store.getCodebaseEnvVars = async () => {
        if (++envCalls === 2 && failure === 'configuration') throw new Error('env lookup exploded');
        return {};
      };
      const deps = makeDeps(store);
      if (failure === 'credential') {
        deps.isPerUserProviderKeysEnabled = () => true;
        deps.getUserProviderCredential = async () => ({
          kind: 'api_key',
          getStatus: async () => ({
            state: 'unusable',
            source: 'archon',
            evidence: 'credential cannot be decrypted',
          }),
        });
      }
      const resolve = mock(async () => ({
        cwd: '/never',
        envId: 'never',
        branchName: 'never',
        baseBranch: 'never',
      }));
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv',
        cwd,
        await discover('parent-plain'),
        'goal',
        { conversationId: 'db', userId: 'originating-user' },
        {
          codebaseId: 'cb',

          resolveChildIsolation: { resolve },
        }
      );
      expect(result.success).toBe(false);
      if (failure === 'credential') {
        const nodeFailed = store.events.find(
          e => e.event_type === 'node_failed' && e.step_name === 'sub'
        );
        expect(String(nodeFailed?.data?.error)).toContain(
          "Credential preflight failed for provider 'codex' (vendor 'openai')"
        );
      }
      expect(resolve).not.toHaveBeenCalled();
      expect([...store.runs.values()].some(r => r.workflow_name === 'child-plain')).toBe(false);
    }
  );

  it('rejects a CASE-VARIANT self-reference by resolving the name before the cycle check (I3)', async () => {
    // The node names its own workflow in a different case; resolveWorkflowName resolves
    // 'SELFIE' → 'selfie', and the cycle check (post-resolution) catches it as a cycle
    // rather than letting it slip to the depth cap.
    await writeWorkflow(
      'selfie',
      `
name: selfie
description: names itself in a different case
nodes:
  - id: sub
    workflow: SELFIE
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('selfie');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'selfie');
    expect(parentRun?.status).toBe('failed');
    // The sub-run node's failure reason is persisted as a node_failed event.
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'sub'
    );
    expect(String(nodeFailed?.data?.error)).toMatch(/cycle/i);
    // Caught as a cycle → no child run was created.
    expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
  });

  it('re-pauses (does NOT double-drive) when the parent is resumed while the child is still paused (I5)', async () => {
    await writeWorkflow(
      'child-gated',
      `
name: child-gated
description: child with an approval gate
nodes:
  - id: implement
    prompt: "implement $ARGUMENTS"
  - id: review-gate
    approval:
      message: "review the sub-run"
    depends_on: [implement]
`
    );
    await writeWorkflow(
      'parent-gated',
      `
name: parent-gated
description: parent composing a gated child
nodes:
  - id: sub
    workflow: child-gated
    input: "goal"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-gated');

    // First drive: child pauses at its gate, parent pauses blocked on it.
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-gated');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-gated');
    expect(parentRun?.status).toBe('paused');
    expect(child?.status).toBe('paused');

    const childEventsBefore = store.events.filter(e => e.workflow_run_id === child!.id).length;

    // Resume the PARENT while the child is STILL paused (child NOT approved). Re-entry
    // must find the paused child and re-pause the parent — never resume the child.
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      parentRun!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    // Parent re-paused; child untouched (still paused, still one run, no new events).
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('paused');
    expect((await store.getWorkflowRun(child!.id))?.status).toBe('paused');
    expect([...store.runs.values()].filter(r => r.workflow_name === 'child-gated')).toHaveLength(1);
    const childEventsAfter = store.events.filter(e => e.workflow_run_id === child!.id).length;
    expect(childEventsAfter).toBe(childEventsBefore); // child was NOT re-driven
  });

  it.each([false, true])(
    'awaits source disposal without hiding an unknown target (cleanup failure=%s)',
    async cleanupFails => {
      await writeWorkflow(
        'parent-typo',
        `
name: parent-typo
description: references a non-existent sub-run
nodes:
  - id: sub
    workflow: does-not-exist-typo
`
      );

      const store = new InMemoryStore();
      const deps = makeDeps(store);
      const parent = await discover('parent-typo');
      const cleanupError = cleanupFails ? new Error('source removal rejected') : undefined;
      const gate = holdSourceRemoval(join(cwd, 'home', 'staged-source'), cleanupError);
      const execution = executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
        conversationId: 'conv-db',
      });

      try {
        const root = await Promise.race([
          gate.started,
          execution.then(() => {
            throw new Error('Execution returned without reaching source disposal');
          }),
        ]);
        let settled = false;
        void execution.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        // Let an incorrectly detached refusal continue while removal remains held.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(existsSync(root)).toBe(true);
        gate.release();
        const result = await execution;
        expect(existsSync(root)).toBe(cleanupFails);
        if (cleanupError) {
          expect(mockLogger.warn).toHaveBeenCalledWith(
            { err: cleanupError, captureRoot: root },
            'workflow.source_capture_dispose_failed'
          );
        }
        expect(result.success).toBe(false);
        const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-typo');
        expect(parentRun?.status).toBe('failed');
        // The node_failed event carries the authoring-friendly reason.
        const nodeFailed = store.events.find(
          e => e.event_type === 'node_failed' && e.step_name === 'sub'
        );
        expect(String(nodeFailed?.data?.error)).toContain('Unknown sub-run workflow');
        // No child run was created for a target that doesn't resolve.
        expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
      } finally {
        gate.release();
        await execution.catch(() => {});
        await gate.finish();
      }
    }
  );
});
