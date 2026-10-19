// @archon-test-isolated
import {
  holdsPathLock,
  InMemoryStore,
  makeProvider,
  makeDeps,
  makePlatform,
  makeFanResolver,
  fanChildEcho,
  fanChildCond,
} from './child-runs/test-utils';
import { providerRegistry } from '@archon/providers';
import {
  readSubrunMetadata,
  readRunDispatchMetadata,
  RUN_DISPATCH_METADATA_KEY,
} from './schemas/workflow-run';
import { settlingProvider } from './test-settling-provider';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import type { WorkflowDeps } from './deps';
import type { IWorkflowStore } from './store';
import { type WorkflowRun } from './schemas/workflow-run';
import type { ResolvedWorkflow } from './schemas/workflow';
import type { ChildIsolationRequest, ChildIsolationResult } from './child-isolation';

/** A fan-out `workflow:` node runs one child per item and joins their outcomes. */
describe('workflow: sub-run fan-out (#2121 slice 2)', () => {
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

  // --- slice 2, PR-C: dynamic fan-out -------------------------------------------

  /** The same child, declared read-only (`mutates_checkout: false` skips the path lock). */
  const fanChildEchoReadOnly = `
name: fan-child-ro
description: echoes its per-item argument; reads only
mutates_checkout: false
nodes:
  - id: echo
    bash: |
      printf 'did:%s' "$ARGUMENTS"
`;

  it('fans out over an N-item array (all_success): N children, ordered aggregate, item→$ARGUMENTS', async () => {
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-parent',
      `
name: fan-parent
description: fan out over a produced list
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta","gamma"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    isolation: worktree
    fan_out:
      items: "$plan.output"
      max_parallel: 2
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-parent');
    const { resolver, calls } = makeFanResolver(cwd);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-parent');
    expect(parentRun?.status).toBe('completed');

    // `isolation: worktree` on the fan-out node isolates every child: the resolver was
    // called once per item, with distinct child indexes.
    expect(calls).toHaveLength(3);
    expect(store.events.some(e => e.event_type === 'workflow.checkout_shared')).toBe(false);
    expect([...calls.map(c => c.childIndex ?? 0)].sort((a, b) => a - b)).toEqual([0, 1, 2]);

    // Three children, each linked to the parent + the fan-out node, keyed by child_index,
    // each in its OWN worktree (distinct working paths, none the parent's checkout).
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child');
    expect(children).toHaveLength(3);
    if (!parentRun) throw new Error('Expected parent run');
    for (const c of children) {
      expect(c.parent_run_id).toBe(parentRun.id);
      expect((c.metadata as Record<string, unknown>).parent_node_id).toBe('work');
      expect(c.status).toBe('completed');
      expect(c.working_path).not.toBe(cwd);
    }
    const byIndex = new Map(
      children.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect([...byIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(new Set(children.map(c => c.working_path)).size).toBe(3);

    // The fan-out node threads a JSON array of child outputs in ITEM order (not
    // started_at order) — proving item→$ARGUMENTS AND index-ordered aggregation.
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual([
      'did:alpha',
      'did:beta',
      'did:gamma',
    ]);
  });

  it('refuses to load a fan-out workflow: node that declares output_format (#2453)', async () => {
    // The per-item contract belongs to each child's own `returns:` node; the caller
    // has nothing to assert, so the load rejects the workflow before a single child
    // run is created.
    await writeWorkflow(
      'fan-parent-caller-schema',
      `
name: fan-parent-caller-schema
description: fan-out declaring a contract the children own
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b"]'
  - id: work
    workflow: fan-child-ok
    depends_on: [plan]
    mutates_checkout: false
    output_format:
      type: object
      properties:
        verdict: { type: string }
    fan_out:
      items: "$plan.output"
      join: all_success
`
    );

    const result = await discoverWorkflows(cwd, {
      providers: providerRegistry,
      loadDefaults: false,
    });
    expect(result.workflows.some(w => w.workflow.name === 'fan-parent-caller-schema')).toBe(false);
    const loadError = result.errors.find(e => e.filename.includes('fan-parent-caller-schema'));
    expect(loadError?.error).toBe(
      "Node 'work' declares output_format on a workflow: node; the result contract belongs to the child's returns: node — declare it there"
    );
  });

  it('read-only children (mutates_checkout: false) fan out IN the parent checkout, no worktrees', async () => {
    await writeWorkflow('fan-child-ro', fanChildEchoReadOnly);
    await writeWorkflow(
      'fan-shared',
      `
name: fan-shared
description: N read-only children over one checkout — the common fan-out shape
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta","gamma"]'
  - id: work
    workflow: fan-child-ro
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-shared');
    const { resolver, calls } = makeFanResolver(cwd);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    // No `isolation:` on the node → no worktree is created, even with a resolver on hand.
    // Nothing about fanning out implies isolation.
    expect(calls).toHaveLength(0);
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-ro');
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c.status).toBe('completed');
      expect(c.working_path).toBe(cwd);
      expect(
        store.events.some(
          e => e.workflow_run_id === c.id && e.event_type === 'workflow.checkout_shared'
        )
      ).toBe(true);
    }
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual([
      'did:alpha',
      'did:beta',
      'did:gamma',
    ]);
  });

  it(
    'runs repo-writing fan-out children in the shared checkout and excludes unrelated runs',
    async () => {
      await writeWorkflow('fan-child', fanChildEcho);
      await writeWorkflow(
        'fan-collide',
        `
name: fan-collide
description: concurrent children over the parent checkout, child does not declare read-only
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta","gamma"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 2
`
      );

      let releaseOverlap: (() => void) | undefined;
      const overlap = new Promise<void>(resolve => {
        releaseOverlap = resolve;
      });
      let releaseQueries: (() => void) | undefined;
      const queriesReady = new Promise<void>(resolve => {
        releaseQueries = resolve;
      });
      let outsideResult: Awaited<ReturnType<typeof executeWorkflow>> | undefined;
      const outside = await discover('fan-child');
      class SharedCheckoutStore extends InMemoryStore {
        maxLiveChildren = 0;
        private firstPair = 0;
        private lockQueries = 0;
        findChildRuns = async (parentRunId: string): Promise<WorkflowRun[]> => {
          const children = [...this.runs.values()].filter(r => r.parent_run_id === parentRunId);
          if (children.length === 1 && children[0] && holdsPathLock(children[0].status)) {
            await Promise.race([
              overlap,
              new Promise<never>((_resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('children did not overlap')), 5000);
                void overlap.then(() => clearTimeout(timer));
              }),
            ]);
          }
          if (children.length >= 2) releaseOverlap?.();
          return [...this.runs.values()].filter(r => r.parent_run_id === parentRunId);
        };
        getActiveWorkflowRunByPath: IWorkflowStore['getActiveWorkflowRunByPath'] = async (
          path,
          self
        ) => {
          const row = self ? this.runs.get(self.id) : undefined;
          if (row?.parent_run_id) {
            this.maxLiveChildren = Math.max(
              this.maxLiveChildren,
              [...this.runs.values()].filter(
                r => r.parent_run_id === row.parent_run_id && holdsPathLock(r.status)
              ).length
            );
          }
          if (row?.parent_run_id && this.firstPair++ === 0) {
            outsideResult = await executeWorkflow(
              makeDeps(this),
              makePlatform(),
              'outside',
              cwd,
              outside,
              'outside',
              { conversationId: 'outside' }
            );
          }
          if (row?.parent_run_id && ++this.lockQueries <= 2) {
            if (this.lockQueries === 2) releaseQueries?.();
            await queriesReady;
          }
          return super.getActiveWorkflowRunByPath(path, self);
        };
      }
      const store = new SharedCheckoutStore();
      const deps = makeDeps(store);
      const parent = await discover('fan-collide');
      const { resolver, calls } = makeFanResolver(cwd);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-plat',
        cwd,
        parent,
        'goal',
        { conversationId: 'conv-db' },
        { resolveChildIsolation: resolver }
      );

      expect(result.success).toBe(true);
      expect(store.maxLiveChildren).toBe(2);
      expect(outsideResult?.success).toBe(false);
      if (outsideResult?.success !== false) throw new Error('outside run was not refused');
      expect(outsideResult.error).toContain('Workflow already active on this path');
      const children = [...store.runs.values()].filter(
        r => r.parent_run_id === result.workflowRunId
      );
      expect(children).toHaveLength(3);
      expect(children.map(c => c.status)).toEqual(['completed', 'completed', 'completed']);
      expect(calls).toHaveLength(0);
      for (const child of children) {
        expect(child.status).toBe('completed');
        expect(child.working_path).toBe(cwd);
        const siblings = store.events
          .filter(
            e => e.workflow_run_id === child.id && e.event_type === 'workflow.checkout_shared'
          )
          .map(e => e.data?.sibling_run_id);
        expect(new Set(siblings)).toEqual(
          new Set(children.filter(c => c.id !== child.id).map(c => c.id))
        );
      }
    },
    testTimeout(20000)
  );

  it(
    'nested fan-out branches share the checkout through both admission orderings',
    async () => {
      await writeWorkflow('fan-leaf', fanChildEcho.replace('name: fan-child', 'name: fan-leaf'));
      await writeWorkflow(
        'fan-nested',
        `
name: fan-nested
description: delegates work
nodes:
  - id: leaf
    workflow: fan-leaf
`
      );
      await writeWorkflow(
        'fan-nested-parent',
        `
name: fan-nested-parent
description: shared nested branches
nodes:
  - id: plan
    bash: printf '%s' '["alpha","beta"]'
  - id: work
    workflow: fan-nested
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 2
`
      );
      for (const leafFirst of [true, false]) {
        let releasePair = () => {};
        const pairReady = new Promise<void>(resolve => {
          releasePair = resolve;
        });
        let releaseLeaf = () => {};
        const leafReady = new Promise<void>(resolve => {
          releaseLeaf = resolve;
        });
        let releasePeer = () => {};
        const peerChecked = new Promise<void>(resolve => {
          releasePeer = resolve;
        });
        class NestedStore extends InMemoryStore {
          getRunAncestry = async (id: string): Promise<WorkflowRun[]> => {
            const run = this.runs.get(id);
            if (
              run?.workflow_name === 'fan-nested' &&
              readSubrunMetadata(run.metadata).childIndex === 1
            ) {
              releasePair();
              await leafReady;
            }
            const ancestors: WorkflowRun[] = [];
            let current = run;
            while (current?.parent_run_id) {
              current = this.runs.get(current.parent_run_id);
              if (current) ancestors.push(current);
            }
            return ancestors;
          };
          findChildRuns = async (id: string): Promise<WorkflowRun[]> => {
            const children = [...this.runs.values()].filter(run => run.parent_run_id === id);
            if (this.runs.get(id)?.workflow_name === 'fan-nested-parent' && children.length > 0) {
              if (children.length >= 2) releasePair();
              await pairReady;
            }
            return [...this.runs.values()].filter(run => run.parent_run_id === id);
          };
          getActiveWorkflowRunByPath: IWorkflowStore['getActiveWorkflowRunByPath'] = async (
            path,
            self
          ) => {
            const run = self ? this.runs.get(self.id) : undefined;
            if (run?.workflow_name === 'fan-leaf') {
              const parent = run.parent_run_id ? this.runs.get(run.parent_run_id) : undefined;
              if (parent && readSubrunMetadata(parent.metadata).childIndex === 0) {
                releaseLeaf();
                if (!leafFirst) await peerChecked;
                const active = await super.getActiveWorkflowRunByPath(path, self);
                if (leafFirst) await peerChecked;
                return active;
              }
            }
            if (
              run?.workflow_name === 'fan-nested' &&
              readSubrunMetadata(run.metadata).childIndex === 1
            ) {
              await leafReady;
              const active = await super.getActiveWorkflowRunByPath(path, self);
              releasePeer();
              return active;
            }
            return super.getActiveWorkflowRunByPath(path, self);
          };
        }
        const store = new NestedStore();
        const result = await executeWorkflow(
          makeDeps(store),
          makePlatform(),
          'conv-plat',
          cwd,
          await discover('fan-nested-parent'),
          'goal',
          { conversationId: 'conv-db' }
        );
        expect(result.success).toBe(true);
        expect([...store.runs.values()].map(run => run.status)).toEqual([
          'completed',
          'completed',
          'completed',
          'completed',
          'completed',
        ]);
      }
    },
    testTimeout(20000)
  );

  it(
    'blocks child execution when either reciprocal sharing record cannot persist',
    async () => {
      await writeWorkflow('fan-child', fanChildEcho);
      await writeWorkflow(
        'fan-audit',
        `
name: fan-audit
description: audit persistence failure
nodes:
  - id: plan
    bash: printf '%s' '["alpha","beta"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 1
      join: all_success
`
      );
      for (const failAt of [1, 2]) {
        const store = new InMemoryStore();
        const persist = store.persistWorkflowEvent;
        let sharingWrites = 0;
        store.persistWorkflowEvent = async event => {
          if (event.event_type === 'workflow.checkout_shared' && ++sharingWrites === failAt) {
            throw new Error('sharing INSERT rejected');
          }
          await persist(event);
        };
        const result = await executeWorkflow(
          makeDeps(store),
          makePlatform(),
          'conv-plat',
          cwd,
          await discover('fan-audit'),
          'goal',
          { conversationId: 'conv-db' }
        );
        expect(result.success).toBe(false);
        const children = [...store.runs.values()].filter(
          run => run.parent_run_id === result.workflowRunId
        );
        expect(children.map(run => run.status)).toEqual(['completed', 'cancelled']);
        const blocked = children[1];
        expect(blocked).toBeDefined();
        expect(
          store.events.some(
            event => event.workflow_run_id === blocked?.id && event.event_type === 'node_started'
          )
        ).toBe(false);
      }
    },
    testTimeout(20000)
  );

  it('a child blocked by a failed checkout-sharing write is re-driven when the parent resumes', async () => {
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-audit-resume',
      `
name: fan-audit-resume
description: a store failure before the child runs must not cancel it for good
nodes:
  - id: plan
    bash: printf '%s' '["alpha","beta"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 1
      join: all_success
`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-audit-resume');
    const persist = store.persistWorkflowEvent;
    let failSharing = true;
    store.persistWorkflowEvent = async event => {
      if (failSharing && event.event_type === 'workflow.checkout_shared') {
        throw new Error('sharing INSERT rejected');
      }
      await persist(event);
    };
    const first = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });
    expect(first.success).toBe(false);
    const blocked = [...store.runs.values()].find(
      run => run.parent_run_id === first.workflowRunId && run.status === 'cancelled'
    );
    expect(blocked?.metadata.cancelled_reason).toBe('fan_out_checkout_check');

    failSharing = false;
    const parentRun = (await store.getWorkflowRun(first.workflowRunId!))!;
    const hydrated = await hydrateResumableRun(deps, parentRun);
    const resumed = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }
    );
    expect(resumed.success).toBe(true);
    expect((await store.getWorkflowRun(blocked!.id))?.status).toBe('completed');
  });

  it('an orphan-cancelled index is re-driven on resume, not left permanently cancelled', async () => {
    // `fan_out_orphan` is stamped by the ENGINE when the item list shrinks under a child.
    // If it is not in the recoverable set it reads as a user cancel: items shrinking and
    // then growing back leaves those slots dead under all_done, and fails the node on every
    // resume under all_success with no way back.
    await writeWorkflow(
      'fan-child',
      `
name: fan-child
description: reports the recovered child's base
nodes:
  - id: run
    bash: 'printf "%s:%s" "$BASE_BRANCH" "$ARGUMENTS"'
`
    );
    await writeWorkflow(
      'fan-orphan-recover',
      `
name: fan-orphan-recover
description: an index cancelled as an orphan must come back when the item returns
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    isolation: worktree
    fan_out:
      items: "$plan.output"
      max_parallel: 2
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-orphan-recover');
    const { resolver } = makeFanResolver(cwd);

    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-orphan-recover',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["a","b"]' },
    });
    // Index 1 was cancelled as an orphan on an earlier attempt (the list was shorter then);
    // the item is back now.
    const orphan = await store.createWorkflowRun({
      workflow_name: 'fan-child',
      origin: { conversationId: 'conv-db' },
      user_message: 'b',
      parent_run_id: parentRun.id,
      working_path: cwd,
      metadata: {
        parent_node_id: 'work',
        child_index: 1,
        cancelled_reason: 'fan_out_orphan',
        [RUN_DISPATCH_METADATA_KEY]: { base_branch: 'orphan-recorded' },
      },
    });
    await store.cancelWorkflowRun(orphan.id);

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      {
        ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }),
        baseOverride: 'changed-parent',
        resolveChildIsolation: resolver,
      }
    );

    // The orphan was re-driven in place and the node completed.
    expect(r.success).toBe(true);
    const completed = await store.getWorkflowRun(orphan.id);
    expect(completed?.status).toBe('completed');
    expect(readRunDispatchMetadata(completed?.metadata)?.base_branch).toBe('orphan-recorded');
    expect(completed?.metadata.summary).toBe('orphan-recorded:b');
  });

  it('leaves an engine-cancelled child recoverable when session loading fails', async () => {
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-session-read-failure',
      `
name: fan-session-read-failure
description: a session read failure must not claim a cancelled child
nodes:
  - id: plan
    bash: |
      printf '%s' '["a"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    isolation: inherit
    fan_out:
      items: "$plan.output"
      max_parallel: 1
      join: all_success
`
    );

    class SessionReadFailureStore extends InMemoryStore {
      failingRunId: string | undefined;
      listWorkflowRunNodeSessions: IWorkflowStore['listWorkflowRunNodeSessions'] = runId => {
        if (runId === this.failingRunId) return Promise.reject(new Error('session read failed'));
        return Promise.resolve([]);
      };
    }

    const store = new SessionReadFailureStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-session-read-failure');
    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-session-read-failure',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["a"]' },
    });
    const child = await store.createWorkflowRun({
      workflow_name: 'fan-child',
      origin: { conversationId: 'conv-db' },
      user_message: 'a',
      parent_run_id: parentRun.id,
      working_path: cwd,
      metadata: { parent_node_id: 'work', child_index: 0 },
    });
    await store.cancelFanOutRun(child.id, 'fan_out_orphan');
    store.failingRunId = child.id;

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }) }
    );

    expect(result.success).toBe(false);
    const childAfter = await store.getWorkflowRun(child.id);
    expect(childAfter?.status).toBe('cancelled');
    expect(childAfter?.metadata.cancelled_reason).toBe('fan_out_orphan');
  });

  it('a child of this node with NO child_index is warned about and cancelled if live', async () => {
    // Converting a node from a 1:1 sub-run to `fan_out:` between attempts leaves a child
    // stamped with parent_node_id and no index. Dropping it silently left it live, billing
    // and untracked — findChildRuns filters on parent_node_id only, so nothing else would
    // ever find it.
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-noindex',
      `
name: fan-noindex
description: a leftover 1:1 child meets a node that now fans out
nodes:
  - id: plan
    bash: |
      printf '%s' '["a"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    isolation: inherit
    fan_out:
      items: "$plan.output"
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-noindex');

    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-noindex',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["a"]' },
    });
    const legacy = await store.createWorkflowRun({
      workflow_name: 'fan-child',
      origin: { conversationId: 'conv-db' },
      user_message: 'from the 1:1 era',
      parent_run_id: parentRun.id,
      working_path: join(cwd, 'legacy'),
      metadata: { parent_node_id: 'work' }, // no child_index
    });
    await store.updateWorkflowRun(legacy.id, { status: 'running' });

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }) }
    );

    // Index 0 ran and the node completed; the untracked leftover was cancelled, not left
    // running forever.
    expect(r.success).toBe(true);
    const after = await store.getWorkflowRun(legacy.id);
    expect(after?.status).toBe('cancelled');
    expect((after?.metadata as Record<string, unknown>).cancelled_reason).toBe('fan_out_orphan');
  });

  it('max_parallel: 1 is a valid serial-in-place fan-out over a repo-writing child', async () => {
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-serial',
      `
name: fan-serial
description: children run one at a time in the parent checkout — no lock contention
nodes:
  - id: plan
    bash: |
      printf '%s' '["alpha","beta"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-serial');
    const { resolver, calls } = makeFanResolver(cwd);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(0);
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child');
    expect(children).toHaveLength(2);
    for (const c of children) expect(c.working_path).toBe(cwd);
  });

  it('an empty items array is a valid zero-width expansion (node completes with [])', async () => {
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-empty',
      `
name: fan-empty
description: fan out over an empty list
nodes:
  - id: plan
    bash: |
      printf '%s' '[]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-empty');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(true);
    // No children were spawned.
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child')).toHaveLength(0);
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(workCompleted?.data?.node_output).toBe('[]');
  });

  it('a non-array items resolution fails the node closed (never silently zero items)', async () => {
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-malformed',
      `
name: fan-malformed
description: items producer emits a JSON object, not an array
nodes:
  - id: plan
    bash: |
      printf '%s' '{"not":"an array"}'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-malformed');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-malformed');
    expect(parentRun?.status).toBe('failed');
    // No children were spawned for an unusable items resolution.
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child')).toHaveLength(0);
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    expect(String(nodeFailed?.data?.error)).toContain('not a JSON array');
  });

  it('the DEFAULT join succeeds with a failed child, aggregating every outcome', async () => {
    // Independence: children are separate jobs, so one failing must not discard its
    // siblings. The default has to carry that — an author who writes no `join:` gets it.
    // Two items keep this e2e case's real-subprocess tree (every child is a real bash
    // spawn plus a checkout snapshot) inside the default per-test budget on slow CI
    // runners while pinning the same join-independence contract.
    await writeWorkflow('fan-child-cond', fanChildCond);
    await writeWorkflow(
      'fan-default-join',
      `
name: fan-default-join
description: no join declared — takes the default
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","boom"]'
  - id: work
    workflow: fan-child-cond
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 2
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-default-join');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    // The node — and the run — SUCCEED despite the middle child failing.
    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-default-join');
    expect(parentRun?.status).toBe('completed');

    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-cond');
    expect(children).toHaveLength(2);

    // Every outcome reaches the aggregate, in item order, with the failure as DATA in
    // its own slot rather than as an absence.
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as unknown[];
    expect(aggregate).toHaveLength(2);
    expect(aggregate[0]).toBe('ok:a');
    expect(aggregate[1]).toMatchObject({ status: 'failed' });
  });

  it('all_success runs EVERY child to terminal after one fails, then fails the node', async () => {
    // The survivors SLEEP, so when the first child fails they are genuinely mid-flight —
    // the window the old fail-fast cancelled them in. With instant children the test would
    // pass either way: they would finish before any cancel could reach them.
    await writeWorkflow(
      'fan-child-slow-cond',
      `
name: fan-child-slow-cond
description: instant fail on "boom"; a slow success otherwise
mutates_checkout: false
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "boom" ]; then exit 3; fi
      sleep 0.25
      printf 'ok:%s' "$ARGUMENTS"
`
    );
    await writeWorkflow(
      'fan-failfast',
      `
name: fan-failfast
description: one child fails under all_success
nodes:
  - id: plan
    bash: |
      printf '%s' '["boom","b","c"]'
  - id: work
    workflow: fan-child-slow-cond
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-failfast');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    // The failing item is FIRST, so under the old fail-fast nothing after it would have
    // spawned. No child's outcome ends another's now: all three exist, each reached its own
    // terminal state, and only then did the join fail the node.
    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-failfast');
    expect(parentRun?.status).toBe('failed');

    const children = [...store.runs.values()].filter(
      r => r.workflow_name === 'fan-child-slow-cond'
    );
    const byIndex = new Map(
      children.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect([...byIndex.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(byIndex.get(0)?.status).toBe('failed');
    // The survivors ran to completion — not cancelled, not skipped, not left non-terminal.
    expect(byIndex.get(1)?.status).toBe('completed');
    expect(byIndex.get(2)?.status).toBe('completed');
    for (const c of children) {
      expect((c.metadata as Record<string, unknown>).cancelled_reason).toBeUndefined();
    }

    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    expect(String(nodeFailed?.data?.error)).toContain('all_success');
    expect(String(nodeFailed?.data?.error)).toContain('child 0');
  });

  it('#2821: all-refused all_done fails at the fan-out and re-dispatches on resume', async () => {
    await writeWorkflow(
      'refused-child',
      `
name: refused-child
description: requires the correctly named input
mutates_checkout: false
inputs:
  expected:
    required: true
nodes:
  - id: run
    bash: "echo should-not-run"
`
    );
    await writeWorkflow(
      'refused-parent',
      `
name: refused-parent
description: all children violate the input contract
nodes:
  - id: work
    workflow: refused-child
    fan_out:
      items: '[1,2,3]'
      as: wrong
      join: all_done
  - id: collector
    depends_on: [work]
    bash: "echo should-not-run"
`
    );
    const store = new InMemoryStore();
    const ancestry = mock(store.getRunAncestry);
    store.getRunAncestry = ancestry;
    const deps = makeDeps(store);
    const platform = makePlatform();
    const workflow = await discover('refused-parent');
    const first = await executeWorkflow(deps, platform, 'conv-plat', cwd, workflow, 'goal', {
      conversationId: 'conv-db',
    });
    expect(first.success).toBe(false);
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'refused-parent')!;
    expect(parent.status).toBe('failed');
    expect(await store.findChildRuns(parent.id)).toEqual([]);
    expect(ancestry).toHaveBeenCalledTimes(3);
    const failures = () =>
      store.events.filter(e => e.event_type === 'node_failed' && e.step_name === 'work');
    expect(failures()).toHaveLength(1);
    expect(failures()[0].data?.failure_kind).toBe('child_failed');
    expect(String(failures()[0].data?.error)).toContain(
      "fan_out node 'work' refused all 3 children at spawn:"
    );
    expect(String(failures()[0].data?.error)).toContain("does not declare input 'wrong'");
    expect(
      store.events.some(e => e.step_name === 'collector' && e.event_type === 'node_started')
    ).toBe(false);
    expect(
      store.events.some(e => e.step_name === 'work' && e.event_type === 'node_completed')
    ).toBe(false);

    await store.createWorkflowRun({
      workflow_name: 'other-node-child',
      origin: { conversationId: 'conv-db' },
      user_message: '',
      parent_run_id: parent.id,
      metadata: { parent_node_id: 'other-node', child_index: 0 },
    });
    for (const metadata of [
      { parent_node_id: 'work' },
      { parent_node_id: 'work', child_index: -1 },
      { parent_node_id: 'work', child_index: 3 },
    ]) {
      const historical = await store.createWorkflowRun({
        workflow_name: 'historical-child',
        origin: { conversationId: 'conv-db' },
        user_message: '',
        parent_run_id: parent.id,
        metadata,
      });
      await store.failWorkflowRun(historical.id, 'historical failure');
    }
    const resume = await hydrateResumableRun(deps, (await store.getWorkflowRun(parent.id))!);
    expect(resume).not.toBeNull();
    const second = await executeWorkflow(
      deps,
      platform,
      'conv-plat',
      cwd,
      workflow,
      'goal',
      { conversationId: 'conv-db' },
      { ...resume! }
    );
    expect(second.success).toBe(false);
    expect(ancestry).toHaveBeenCalledTimes(6);
    expect(failures()).toHaveLength(2);
    expect(failures()[1].data?.error).toBe(failures()[0].data?.error);
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(messages).toContain("Re-driving fan_out node 'work'");
    expect(messages).toContain('no child run rows');
  });

  it('#2821: partial refusal preserves failed-child markers and reports them when resume skips', async () => {
    await writeWorkflow(
      'partial-child',
      `
name: partial-child
description: starts and fails
mutates_checkout: false
nodes:
  - id: run
    bash: "exit 1"
`
    );
    await writeWorkflow(
      'partial-parent',
      `
name: partial-parent
description: one child starts, two are refused
nodes:
  - id: work
    workflow: partial-child
    isolation: worktree
    fan_out:
      items: '[1,2,3]'
      join: all_done
  - id: collector
    depends_on: [work]
    bash: "exit 1"
`
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const platform = makePlatform();
    const workflow = await discover('partial-parent');
    const resolve = mock(async (request: ChildIsolationRequest): Promise<ChildIsolationResult> => {
      if (request.childIndex !== 0) throw new Error('resource unavailable');
      return {
        cwd,
        envId: 'test-child',
        branchName: 'test-child',
        baseBranch: { kind: 'resolved', value: 'child-release' },
      };
    });
    const options = { resolveChildIsolation: { resolve } };
    await executeWorkflow(
      deps,
      platform,
      'conv-plat',
      cwd,
      workflow,
      'goal',
      { conversationId: 'conv-db' },
      options
    );
    const parent = [...store.runs.values()].find(r => r.workflow_name === 'partial-parent')!;
    const children = await store.findChildRuns(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('failed');
    const completed = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    const aggregate: unknown = JSON.parse(String(completed?.data?.node_output));
    if (!Array.isArray(aggregate)) throw new Error('Expected a fan-out aggregate array');
    expect(aggregate).toHaveLength(3);
    expect(aggregate[0]).toEqual({
      archon_failed: true,
      status: 'failed',
      error: expect.any(String),
    });
    expect(aggregate.slice(1)).toEqual(
      [1, 2].map(() => ({
        archon_failed: true,
        status: 'failed',
        error:
          "Failed to create isolated worktree for sub-run 'partial-child': resource unavailable",
      }))
    );

    const resume = await hydrateResumableRun(deps, (await store.getWorkflowRun(parent.id))!);
    expect(resume?.priorCompletedNodes.has('work')).toBe(true);
    await executeWorkflow(
      deps,
      platform,
      'conv-plat',
      cwd,
      workflow,
      'goal',
      { conversationId: 'conv-db' },
      {
        ...options,
        ...resume!,
      }
    );
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(await store.findChildRuns(parent.id)).toHaveLength(1);
    expect(
      store.events.some(
        e => e.event_type === 'node_skipped_prior_success' && e.step_name === 'work'
      )
    ).toBe(true);
    const messages = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(c => String(c[1]))
      .join('\n');
    expect(messages).toContain(
      "Skipping fan_out node 'work': fan-out previously refused 2 of 3 children"
    );
  });

  it('all_done: a partial failure still completes the node; the failed entry is represented', async () => {
    // Two items: same mechanism as the DEFAULT-join case above — every child is a real
    // subprocess under one test clock, so the fan-out stays minimal for slow CI runners.
    await writeWorkflow('fan-child-cond', fanChildCond);
    await writeWorkflow(
      'fan-alldone',
      `
name: fan-alldone
description: all_done tolerates a partial failure
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","boom"]'
  - id: work
    workflow: fan-child-cond
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 2
      join: all_done
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-alldone');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    // all_done never fails on a partial failure.
    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-alldone');
    expect(parentRun?.status).toBe('completed');
    // Both children ran (no fail-fast under all_done).
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child-cond')).toHaveLength(
      2
    );

    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as unknown[];
    expect(aggregate[0]).toBe('ok:a');
    // The failed child is represented as the marked error object, not dropped.
    expect(aggregate[1]).toMatchObject({ archon_failed: true, status: 'failed' });
  });

  it('bounds concurrency to max_parallel (sliding window over the children)', async () => {
    await writeWorkflow(
      'fan-child-slow',
      `
name: fan-child-slow
description: one AI turn per child (concurrency observable via the provider)
mutates_checkout: false
nodes:
  - id: think
    prompt: "work on $ARGUMENTS"
`
    );
    await writeWorkflow(
      'fan-window',
      `
name: fan-window
description: five children, window of two
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b","c","d","e"]'
  - id: work
    workflow: fan-child-slow
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 2
`
    );

    const store = new InMemoryStore();
    // Concurrency-tracking provider: the in-flight count during the awaited "AI turn"
    // reflects how many children run at once. A turn holds until a second turn joins
    // it, so the window is observed rather than raced: a slow runner staggers child
    // start-up past any fixed overlap sleep. The fifth turn has no partner left and
    // runs alone. An engine that serialized the children leaves the first turn
    // waiting, and the test fails on its budget.
    const tracker = { inFlight: 0, max: 0, started: 0 };
    let releaseWaitingTurn: (() => void) | undefined;
    const slowProvider = {
      ...makeProvider(),
      sendQuery: async function* () {
        tracker.started++;
        tracker.inFlight++;
        tracker.max = Math.max(tracker.max, tracker.inFlight);
        if (releaseWaitingTurn) {
          releaseWaitingTurn();
          releaseWaitingTurn = undefined;
        } else if (tracker.started < 5) {
          await new Promise<void>(resolve => {
            releaseWaitingTurn = resolve;
          });
        }
        // Stay in flight briefly so an over-limit third child, if admitted, is counted.
        await new Promise(r => setTimeout(r, 15));
        tracker.inFlight--;
        yield { type: 'agent_message_chunk', text: 'ai-output' };
        yield { type: 'result', sessionId: 'sess', cost: 0.01 };
      },
    };
    const deps = {
      ...makeDeps(store),
      getAgentProvider: mock(() =>
        settlingProvider(slowProvider)
      ) as unknown as WorkflowDeps['getAgentProvider'],
    };
    const parent = await discover('fan-window');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(true);
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child-slow')).toHaveLength(
      5
    );
    // Never more than max_parallel children in flight at once, and the window IS used
    // (two ran concurrently — proving it isn't accidentally serial).
    expect(tracker.max).toBe(2);
  });

  function makeAccountingDeps(store: IWorkflowStore): WorkflowDeps {
    const paidProvider = makeProvider();
    const provider = {
      ...paidProvider,
      sendQuery: mock(function* (prompt: string) {
        if (prompt.includes('CHECK_SPEND')) {
          if (prompt.includes('doomed')) throw new Error('failed after paid work');
          // The check adds no usage to the preceding paid node's accounting.
          yield { type: 'agent_message_chunk', text: 'check passed' };
          yield { type: 'result', sessionId: 'check' };
          return;
        }
        yield* paidProvider.sendQuery();
      }),
    };
    return {
      ...makeDeps(store),
      getAgentProvider: mock(() =>
        settlingProvider(provider)
      ) as unknown as WorkflowDeps['getAgentProvider'],
    };
  }

  it('rolls up child cost onto the fan-out node (Σ child costs → parent total)', async () => {
    await writeWorkflow(
      'fan-child-cost',
      `
name: fan-child-cost
description: one AI turn (canned cost 0.01) per child
mutates_checkout: false
nodes:
  - id: think
    prompt: "work on $ARGUMENTS"
`
    );
    await writeWorkflow(
      'fan-cost',
      `
name: fan-cost
description: three AI children, cost rolls up
nodes:
  - id: work
    workflow: fan-child-cost
    fan_out:
      items: '["a","b","c"]'
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-cost');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-cost');
    // 3 children × 0.01 each = 0.03 rolled up to the parent (the parent has no other paid nodes).
    expect((parentRun?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.03, 5);

    // Usage must be PERSISTED on the node_completed event, not merely computed. These
    // are the axes getDagResumeSnapshot sums to rebuild a run's usage across resume
    // passes, so dropping either here under-reports every resumed run by exactly the
    // children's usage — silently, since an absent key is skipped without warning.
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(workCompleted?.data?.cost_usd).toBeCloseTo(0.03, 5);
    expect(workCompleted?.data?.tokens).toBeDefined();
  });

  // #2469 (R1) — the 1:1 topology, not just fan-out. The fan-out `failResult` has
  // carried a failed child's usage since #2224; the single-child one dropped it, so a
  // parent with one ordinary `workflow:` node still reported zero for a child that
  // burned tokens and then failed. That is the more common shape of the two.
  it("rolls up a failed 1:1 child's spend into the parent (no fan_out)", async () => {
    await writeWorkflow(
      'solo-child-doomed',
      `
name: solo-child-doomed
description: one AI turn (canned cost 0.01 / 7 in / 3 out), then fails
mutates_checkout: false
nodes:
  - id: think
    prompt: "work on $ARGUMENTS"
  - id: fail
    depends_on: [think]
    prompt: "CHECK_SPEND doomed"
`
    );
    await writeWorkflow(
      'solo-parent',
      `
name: solo-parent
description: a single non-fan-out sub-run node whose child fails after spending
nodes:
  - id: work
    workflow: solo-child-doomed
    input: "the task"
`
    );

    const store = new InMemoryStore();
    const deps = makeAccountingDeps(store);
    const parent = await discover('solo-parent');
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    const child = [...store.runs.values()].find(r => r.workflow_name === 'solo-child-doomed');
    expect(child?.status).toBe('failed');
    // The child's own row records the spend (the run-tail write).
    expect((child?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.01, 5);

    // ...and so does the parent's, via the node result the failed branch now carries.
    // The node failed, so the parent run failed too — which is exactly the case that
    // used to report nothing at all.
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'solo-parent');
    expect(parentRun?.status).toBe('failed');
    expect((parentRun?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.01, 5);
    expect((parentRun?.metadata as Record<string, unknown>).total_tokens_in).toBe(7);
    expect((parentRun?.metadata as Record<string, unknown>).total_cache_read_tokens).toBe(5);
    expect((parentRun?.metadata as Record<string, unknown>).total_cache_write_tokens).toBe(0);
    expect((parentRun?.metadata as Record<string, unknown>).total_tokens_out).toBe(3);
  });

  // #2469 — the regression proof. `all_done` is the DEFAULT join and a failing child
  // explicitly must not discard its siblings, so partial failure is a designed, routine
  // outcome. Before this fix a child that burned tokens and then failed recorded no
  // spend at all, and the fan-out reported Σ of *completed* children: plausible, lower
  // than reality, and with no warning to prompt investigation.
  it('rolls up the spend of EVERY child, including ones that failed after burning tokens', async () => {
    await writeWorkflow(
      'fan-child-partial',
      `
name: fan-child-partial
description: one AI turn (canned cost 0.01 / 7 in / 3 out), then the "doomed" item fails
mutates_checkout: false
nodes:
  - id: think
    prompt: "work on $ARGUMENTS"
  - id: check
    depends_on: [think]
    prompt: "CHECK_SPEND $ARGUMENTS"
`
    );
    await writeWorkflow(
      'fan-partial',
      `
name: fan-partial
description: three children, one fails AFTER its AI node already spent tokens
nodes:
  - id: work
    workflow: fan-child-partial
    fan_out:
      items: '["a","doomed","c"]'
`
    );

    const store = new InMemoryStore();
    const deps = makeAccountingDeps(store);
    const parent = await discover('fan-partial');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    // all_done: the failed child is represented in the aggregate, not fatal to the node.
    expect(result.success).toBe(true);
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-partial');
    expect(children).toHaveLength(3);
    const failedChild = children.find(r => r.status === 'failed');
    expect(failedChild).toBeDefined();
    expect(children.filter(child => child.status === 'completed')).toHaveLength(2);
    expect(children.filter(child => child.status === 'failed')).toHaveLength(1);
    expect(
      store.events.filter(
        event =>
          event.workflow_run_id === failedChild?.id &&
          event.event_type === 'node_completed' &&
          event.step_name === 'think'
      )
    ).toHaveLength(1);

    // The failed child's OWN row carries what it spent. This is the assertion that
    // fails on the pre-fix engine: failWorkflowRun wrote only { error }.
    const failedMeta = failedChild?.metadata as Record<string, unknown>;
    expect(failedMeta.total_cost_usd).toBeCloseTo(0.01, 5);
    expect(failedMeta.total_tokens_in).toBe(7);
    expect(failedMeta.total_tokens_out).toBe(3);

    // 3 children × 0.01 = 0.03 — Σ of ALL three, not the 0.02 of the two that completed.
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-partial');
    expect((parentRun?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.03, 5);
    expect((parentRun?.metadata as Record<string, unknown>).total_tokens_in).toBe(21);
    expect((parentRun?.metadata as Record<string, unknown>).total_cache_read_tokens).toBe(15);
    expect((parentRun?.metadata as Record<string, unknown>).total_cache_write_tokens).toBe(0);
    expect((parentRun?.metadata as Record<string, unknown>).total_tokens_out).toBe(9);
  });

  it('parent resume re-drives only the failed instance, skipping completed ones (1:N re-entry)', async () => {
    await writeWorkflow(
      'fan-child-flaky',
      `
name: fan-child-flaky
description: the "flaky" item fails once then recovers; others always succeed (writes a marker file)
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "flaky" ]; then
        test -f flaky-marker && printf 'recovered' || { touch flaky-marker; exit 3; }
      else
        printf 'ok:%s' "$ARGUMENTS"
      fi
`
    );
    // Concurrent, and deterministic without any choreography: with no fail-fast, nothing
    // cancels a sibling, so run 1 always ends index 0 completed and index 1 failed.
    // (This test used to be pinned to max_parallel: 1 purely to dodge that race.)
    // Two items keep this e2e case's real-subprocess tree (plan node + one real bash
    // child per item, all under one clock) inside the default per-test budget on slow CI
    // runners; one completed survivor still proves completed siblings are threaded
    // from their rows on resume, not re-driven.
    await writeWorkflow(
      'fan-resume',
      `
name: fan-resume
description: one flaky instance recovers on parent resume
nodes:
  - id: plan
    bash: |
      printf '%s' '["keep0","flaky"]'
  - id: work
    workflow: fan-child-flaky
    depends_on: [plan]
    isolation: worktree
    fan_out:
      items: "$plan.output"
      max_parallel: 3
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-resume');
    const { resolver } = makeFanResolver(cwd);

    // First drive: the flaky child (index 1) fails; index 0 runs to completion
    // regardless, and the node fails afterwards under all_success.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      // baseBranch is pinned so the executor's $BASE_BRANCH resolution never falls
      // through to git auto-detection — nothing in this test asserts that detection,
      // and every level it reached would otherwise pay for it again.
      { baseBranch: 'main', resolveChildIsolation: resolver }
    );
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-resume');
    const children1 = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-flaky');
    expect(children1).toHaveLength(2);
    const byIndex1 = new Map(
      children1.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect(byIndex1.get(0)?.status).toBe('completed');
    expect(byIndex1.get(1)?.status).toBe('failed');
    const completedAtBefore = byIndex1.get(0)!.completed_at;

    // Resume the PARENT: only the failed index-1 child is re-driven (marker now present →
    // recovered); the two COMPLETED siblings are threaded from their rows, not re-executed.
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
      // Same auto-detection opt-out as drive 1; nothing here asserts branch detection.
      { baseBranch: 'main', ...resumeOpts, resolveChildIsolation: resolver }
    );

    expect(r2.success).toBe(true);
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('completed');
    // Exactly 2 child rows — one per index; the failed one was re-driven in its own row.
    expect(
      [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-flaky')
    ).toHaveLength(2);
    // The completed child was threaded from its row, not re-executed. Row count can't show
    // this (a re-drive reuses the row) but completed_at can — re-driving it would stamp a
    // new one, even though its own DAG node would be skipped by the child's resume.
    expect((await store.getWorkflowRun(byIndex1.get(0)!.id))?.completed_at).toEqual(
      completedAtBefore
    );
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual(['ok:keep0', 'recovered']);
  });
});
