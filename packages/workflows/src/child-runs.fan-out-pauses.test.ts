// @archon-test-isolated
import {
  makeDeps,
  makePlatform,
  makeFanResolver,
  fanChildEcho,
  fanChildCond,
} from './child-runs/test-utils';
import { InMemoryStore } from './child-runs/test-store';
import { providerRegistry } from '@archon/providers';
import type { InMemoryStoreEvent } from './test-utils';
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeWorkflow } from './executor';
import { executionClaim } from './store';
import { hydrateResumableRun } from './run-resume';
import { discoverWorkflows } from './workflow-discovery';
import type { WorkflowDeps, IWorkflowPlatform } from './deps';
import { type WorkflowRun } from './schemas/workflow-run';
import type { ResolvedWorkflow } from './schemas/workflow';

/** Fan-out children that pause wait as their own runs, and the parent resumes around them. */
describe('workflow: fan-out children that pause (#4044)', () => {
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

  /** A fan-out child that pauses at an approval gate only for items where `item <op> askFor`. */
  const fanAskChild = (name: string, askFor: string, op: '==' | '!=' = '=='): string => `
name: ${name}
description: asks for review on one item only
nodes:
  - id: echo
    bash: |
      printf '%s' "$ARGUMENTS"
  - id: ask
    approval:
      message: "review $echo.output"
    depends_on: [echo]
    when: "$echo.output ${op} '${askFor}'"
  - id: done
    bash: |
      printf 'did:%s' "$ARGUMENTS"
    depends_on: [echo, ask]
    trigger_rule: none_failed_min_one_success
`;

  const fanAskParent = (name: string, child: string, items: string, fanOut: string): string => `
name: ${name}
description: fans out over children that may pause
nodes:
  - id: plan
    bash: |
      printf '%s' '${items}'
  - id: work
    workflow: ${child}
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
${fanOut}
`;

  /** Approve a paused child's gate and continue it, which fires the parent's hook. */
  async function answerChild(
    deps: WorkflowDeps,
    store: InMemoryStore,
    childId: string,
    childWorkflow: string
  ): Promise<void> {
    store.approveGate(childId);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(childId))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover(childWorkflow),
      (await store.getWorkflowRun(childId))!.user_message,
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );
  }

  const childByItem = (store: InMemoryStore, workflowName: string): Map<string, WorkflowRun> =>
    new Map(
      [...store.runs.values()]
        .filter(r => r.workflow_name === workflowName)
        .map(r => [r.user_message, r])
    );

  it('a fan-out child that pauses waits as its own run; the parent continues when it finishes (#4044)', async () => {
    await writeWorkflow('fan-ask', fanAskChild('fan-ask', 'b'));
    await writeWorkflow(
      'fan-ask-parent',
      fanAskParent('fan-ask-parent', 'fan-ask', '["a","b","c"]', '      max_parallel: 3')
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);

    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );
    expect(r1.success && 'paused' in r1 && r1.paused).toBe(true);

    const children = childByItem(store, 'fan-ask');
    expect(children.get('a')?.status).toBe('completed');
    expect(children.get('c')?.status).toBe('completed');
    const b = children.get('b')!;
    expect(b.status).toBe('paused');
    expect(b.metadata.cancelled_reason).toBeUndefined();

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-ask-parent')!;
    expect(parentRun.status).toBe('paused');
    expect(parentRun.metadata.approval).toMatchObject({
      type: 'fan_out',
      nodeId: 'work',
      childRunIds: [b.id],
      unspawnedItems: 0,
    });
    expect(
      store.events.some(
        e =>
          (e.event_type === 'node_completed' || e.event_type === 'node_failed') &&
          e.step_name === 'work'
      )
    ).toBe(false);

    await answerChild(deps, store, b.id, 'fan-ask');

    expect((await store.getWorkflowRun(b.id))?.status).toBe('completed');
    expect((await store.getWorkflowRun(parentRun.id))?.status).toBe('completed');
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual([
      'did:a',
      'did:b',
      'did:c',
    ]);
  });

  it('a paused fan-out child keeps its max_parallel slot; later items start after it finishes (#4044 D2)', async () => {
    await writeWorkflow('fan-ask-serial', fanAskChild('fan-ask-serial', 'a'));
    await writeWorkflow(
      'fan-ask-serial-parent',
      fanAskParent(
        'fan-ask-serial-parent',
        'fan-ask-serial',
        '["a","b","c"]',
        '      max_parallel: 1'
      )
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    // Track the most children of this fan-out ever unfinished at once.
    let maxUnfinished = 0;
    const observe = (): void => {
      const unfinished = [...store.runs.values()].filter(
        r =>
          r.workflow_name === 'fan-ask-serial' &&
          (r.status === 'running' || r.status === 'pending' || r.status === 'paused')
      ).length;
      maxUnfinished = Math.max(maxUnfinished, unfinished);
    };
    const createRun = store.createWorkflowRun;
    store.createWorkflowRun = async data => {
      observe();
      return createRun(data);
    };
    const claim = store.claimPendingWorkflowRun;
    store.claimPendingWorkflowRun = async (id, workingPath) => {
      const claimed = await claim(id, workingPath);
      observe();
      return claimed;
    };

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-serial-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    const first = childByItem(store, 'fan-ask-serial');
    expect([...first.keys()]).toEqual(['a']);
    expect(first.get('a')?.status).toBe('paused');
    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'fan-ask-serial-parent'
    )!;
    expect(parentRun.metadata.approval).toMatchObject({
      type: 'fan_out',
      childRunIds: [first.get('a')!.id],
      unspawnedItems: 2,
    });

    await answerChild(deps, store, first.get('a')!.id, 'fan-ask-serial');

    expect((await store.getWorkflowRun(parentRun.id))?.status).toBe('completed');
    const all = childByItem(store, 'fan-ask-serial');
    expect([...all.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect([...all.values()].every(r => r.status === 'completed')).toBe(true);
    expect(maxUnfinished).toBe(1);
  });

  it('a fan-out parent stays paused until every held child finishes (#4044 D5)', async () => {
    await writeWorkflow('fan-ask-two', fanAskChild('fan-ask-two', 'c', '!='));
    await writeWorkflow(
      'fan-ask-two-parent',
      fanAskParent('fan-ask-two-parent', 'fan-ask-two', '["a","b","c"]', '      max_parallel: 3')
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const pause = store.pauseWorkflowRun;
    let fanOutPauses = 0;
    store.pauseWorkflowRun = (id, approval, extra, event) => {
      if (approval.type === 'fan_out') fanOutPauses += 1;
      return pause(id, approval, extra, event);
    };

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-two-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );

    const children = childByItem(store, 'fan-ask-two');
    const [a, b] = [children.get('a')!, children.get('b')!];
    expect([a.status, b.status, children.get('c')?.status]).toEqual([
      'paused',
      'paused',
      'completed',
    ]);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-ask-two-parent')!;
    const gate = parentRun.metadata.approval;
    expect(gate).toMatchObject({ type: 'fan_out', childRunIds: [a.id, b.id] });
    expect(fanOutPauses).toBe(1);

    await answerChild(deps, store, a.id, 'fan-ask-two');

    expect((await store.getWorkflowRun(a.id))?.status).toBe('completed');
    const held = await store.getWorkflowRun(parentRun.id);
    expect(held?.status).toBe('paused');
    expect(held?.metadata.approval).toEqual(gate);
    expect(fanOutPauses).toBe(1);

    await answerChild(deps, store, b.id, 'fan-ask-two');

    expect((await store.getWorkflowRun(parentRun.id))?.status).toBe('completed');
    expect(fanOutPauses).toBe(1);
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual([
      'did:a',
      'did:b',
      'did:c',
    ]);
  });

  it('continuing a fan-out holds a child that is running, without failing the node or cancelling it (#4044)', async () => {
    await writeWorkflow('fan-ask-live', fanAskChild('fan-ask-live', 'c', '!='));
    await writeWorkflow(
      'fan-ask-live-parent',
      fanAskParent('fan-ask-live-parent', 'fan-ask-live', '["a","b"]', '      max_parallel: 2')
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-live-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );
    const children = childByItem(store, 'fan-ask-live');
    const [a, b] = [children.get('a')!, children.get('b')!];
    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'fan-ask-live-parent'
    )!;
    expect(parentRun.metadata.approval).toMatchObject({
      type: 'fan_out',
      childRunIds: [a.id, b.id],
    });

    // b was answered and its continuation is driving it when the parent is continued.
    await store.updateWorkflowRun(b.id, { status: 'running' });
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-live-parent'),
      'goal',
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    expect(result.success && 'paused' in result && result.paused).toBe(true);
    expect(store.events.some(e => e.event_type === 'node_failed' && e.step_name === 'work')).toBe(
      false
    );
    expect((await store.getWorkflowRun(a.id))?.status).toBe('paused');
    expect((await store.getWorkflowRun(b.id))?.status).toBe('running');
    const held = await store.getWorkflowRun(parentRun.id);
    expect(held?.status).toBe('paused');
    expect(held?.metadata.approval).toMatchObject({
      type: 'fan_out',
      childRunIds: [a.id, b.id],
    });
  });

  it('continuing a fan-out does not re-drive a child that already failed (#4044 D3)', async () => {
    await writeWorkflow(
      'fan-ask-fail',
      `
name: fan-ask-fail
description: fails on x, asks on y
nodes:
  - id: echo
    bash: |
      printf '%s' "$ARGUMENTS"
  - id: boom
    bash: |
      exit 3
    depends_on: [echo]
    when: "$echo.output == 'x'"
  - id: ask
    approval:
      message: "review $echo.output"
    depends_on: [echo]
    when: "$echo.output == 'y'"
  - id: done
    bash: |
      printf 'did:%s' "$ARGUMENTS"
    depends_on: [boom, ask]
    trigger_rule: none_failed_min_one_success
`
    );
    await writeWorkflow(
      'fan-ask-fail-parent',
      fanAskParent(
        'fan-ask-fail-parent',
        'fan-ask-fail',
        '["x","y"]',
        '      max_parallel: 2\n      join: all_done'
      )
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-fail-parent'),
      'goal',
      { conversationId: 'conv-db' }
    );
    const children = childByItem(store, 'fan-ask-fail');
    const x = children.get('x')!;
    const y = children.get('y')!;
    expect(x.status).toBe('failed');
    expect(y.status).toBe('paused');
    // The answered sibling records the shared checkout on x's row again when it resumes;
    // what must not change is x's own execution.
    const xExecution = (): InMemoryStoreEvent[] =>
      store.events.filter(
        e => e.workflow_run_id === x.id && e.event_type !== 'workflow.checkout_shared'
      );
    const xEventsAfterFirstDrive = xExecution().length;

    await answerChild(deps, store, y.id, 'fan-ask-fail');

    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'fan-ask-fail-parent'
    )!;
    expect(parentRun.status).toBe('completed');
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as unknown[];
    expect(aggregate[0]).toMatchObject({ archon_failed: true, status: 'failed' });
    expect(aggregate[1]).toBe('did:y');
    expect((await store.getWorkflowRun(x.id))?.status).toBe('failed');
    expect(xExecution()).toHaveLength(xEventsAfterFirstDrive);
  });

  it('a fan-out parent continues itself when its last held child finishes before the pause commits (#4044 D5)', async () => {
    await writeWorkflow('fan-ask-race', fanAskChild('fan-ask-race', 'b'));
    await writeWorkflow(
      'fan-ask-race-parent',
      fanAskParent('fan-ask-race-parent', 'fan-ask-race', '["a","b"]', '      max_parallel: 2')
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);
    // The held child finishes between the node's refresh and its pause: its own hook
    // would have seen the parent still running and stood down.
    const pause = store.pauseWorkflowRun;
    let raced = false;
    store.pauseWorkflowRun = (id, approval, extra, suspension) => {
      if (approval.type === 'fan_out' && !raced) {
        raced = true;
        for (const childId of approval.childRunIds ?? []) {
          const child = store.runs.get(childId)!;
          child.status = 'completed';
          child.completed_at = new Date();
          child.metadata = { ...child.metadata, summary: 'did:b' };
        }
      }
      return pause(id, approval, extra, suspension);
    };

    const claims: (string | null)[] = [];
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-race-parent'),
      'goal',
      { conversationId: 'conv-db' },
      {
        onExecutionClaimed: claim => {
          claims.push(claim);
        },
      }
    );

    expect(claims).toHaveLength(2);
    expect(claims[0]).toBeNull();
    expect(raced).toBe(true);
    expect(result.success).toBe(true);
    expect('paused' in result && result.paused).toBeFalsy();
    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'fan-ask-race-parent'
    )!;
    expect(claims[1]).toBe(executionClaim(parentRun.metadata));
    expect(parentRun.status).toBe('completed');
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual(['did:a', 'did:b']);
  });

  it('a child cancelled by the old fan_out_gate behavior is re-driven and now waits (#4044 upgrade)', async () => {
    await writeWorkflow('fan-ask-legacy', fanAskChild('fan-ask-legacy', 'x'));
    await writeWorkflow(
      'fan-ask-legacy-parent',
      fanAskParent('fan-ask-legacy-parent', 'fan-ask-legacy', '["x"]', '      max_parallel: 1')
    );
    const store = new InMemoryStore();
    const deps = makeDeps(store);

    // A parent that failed under the old behavior: its child paused and was cancelled
    // with `fan_out_gate`, and the fan-out node failed.
    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-ask-legacy-parent',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push(
      {
        workflow_run_id: parentRun.id,
        event_type: 'node_completed',
        step_name: 'plan',
        data: { node_output: '["x"]' },
      },
      {
        workflow_run_id: parentRun.id,
        event_type: 'node_failed',
        step_name: 'work',
        data: { error: 'paused at an approval gate' },
      }
    );
    await store.failWorkflowRun(parentRun.id, 'fan-out gate rejected');
    const legacy = await store.createWorkflowRun({
      workflow_name: 'fan-ask-legacy',
      origin: { conversationId: 'conv-db' },
      user_message: 'x',
      parent_run_id: parentRun.id,
      working_path: cwd,
      metadata: { parent_node_id: 'work', child_index: 0 },
    });
    await store.cancelFanOutRun(legacy.id, 'fan_out_gate');

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('fan-ask-legacy-parent'),
      'goal',
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    expect(result.success && 'paused' in result && result.paused).toBe(true);
    const child = await store.getWorkflowRun(legacy.id);
    expect(child?.status).toBe('paused');
    expect(child?.metadata.cancelled_reason).toBeUndefined();
    expect((await store.getWorkflowRun(parentRun.id))?.metadata.approval).toMatchObject({
      type: 'fan_out',
      childRunIds: [legacy.id],
    });
  });

  it('a running fan-out child found on resume fails the node WITHOUT cancelling it (C1)', async () => {
    // Mirrors the Slack adapter: its registered slash command is `/archon-workflow`.
    const platform: IWorkflowPlatform = {
      ...makePlatform(),
      formatWorkflowCommand: (command: string) => `/archon-workflow ${command}`,
    };
    await writeWorkflow('fan-child-echo2', fanChildEcho.replace('fan-child', 'fan-child-echo2'));
    await writeWorkflow(
      'fan-c1',
      `
name: fan-c1
description: parent with one fan-out child (inherit — no resolver needed)
nodes:
  - id: plan
    bash: |
      printf '%s' '["x"]'
  - id: work
    workflow: fan-child-echo2
    depends_on: [plan]
    isolation: inherit
    fan_out:
      items: "$plan.output"
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-c1');

    // Seed a resumable parent: plan already completed, and a crash-orphan child left
    // 'running' at index 0 with recent activity (fresh, not stale).
    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-c1',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["x"]' },
    });
    const child = await store.createWorkflowRun({
      workflow_name: 'fan-child-echo2',
      origin: { conversationId: 'conv-db' },
      user_message: 'x',
      parent_run_id: parentRun.id,
      working_path: cwd,
      metadata: { parent_node_id: 'work', child_index: 0 },
    });
    await store.updateWorkflowRun(child.id, { status: 'running' });

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      platform,
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      {
        ...hydrated!,
      }
    );

    expect(r.success).toBe(false);
    // The ambiguous running child is NOT autonomously cancelled (AGENTS.md "Do not guess lifecycle ownership").
    expect((await store.getWorkflowRun(child.id))?.status).toBe('running');
    const nodeFailed = [...store.events]
      .reverse()
      .find(e => e.event_type === 'node_failed' && e.step_name === 'work');
    const failureText = String(nodeFailed?.data?.error);
    expect(failureText).toContain('may still be running');
    expect(failureText).not.toContain('gate');

    // #3488: one string used to serve both the live notice and the stored failure, so
    // every surface got whichever command spelling was hard-coded. The stored record now
    // names the run and carries it as data; the notice spells the command for its own
    // platform.
    expect(failureText).toContain(child.id);
    expect(failureText).not.toContain('/workflow ');
    expect(failureText).not.toContain('archon workflow ');
    expect(nodeFailed?.data?.blocked_on_child_run_id).toBe(child.id);

    const notices = (platform.sendMessage as ReturnType<typeof mock>).mock.calls
      .map(([, message]) => String(message))
      .join('\n');
    expect(notices).toContain(`/archon-workflow abandon ${child.id}`);
    expect(notices.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    expect(notices).not.toContain('archon workflow ');
  });

  it('an out-of-range child_index (shrunk items) is warned + a live orphan cancelled (I2)', async () => {
    await writeWorkflow('fan-child-echo2', fanChildEcho.replace('fan-child', 'fan-child-echo2'));
    await writeWorkflow(
      'fan-i2',
      `
name: fan-i2
description: items shrank between attempts — a child_index falls out of range
nodes:
  - id: plan
    bash: |
      printf '%s' '["only-one"]'
  - id: work
    workflow: fan-child-echo2
    depends_on: [plan]
    isolation: inherit
    fan_out:
      items: "$plan.output"
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-i2');

    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-i2',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["only-one"]' },
    });
    // A leftover child at index 5 (items now length 1) still 'running'.
    const orphan = await store.createWorkflowRun({
      workflow_name: 'fan-child-echo2',
      origin: { conversationId: 'conv-db' },
      user_message: 'gone',
      parent_run_id: parentRun.id,
      working_path: join(cwd, 'orphan-wt'),
      metadata: { parent_node_id: 'work', child_index: 5 },
    });
    await store.updateWorkflowRun(orphan.id, { status: 'running' });

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { ...hydrated! }
    );

    // Index 0 ran fresh and the node completed; the out-of-range orphan was cancelled + tagged.
    expect(r.success).toBe(true);
    const orphanAfter = await store.getWorkflowRun(orphan.id);
    expect(orphanAfter?.status).toBe('cancelled');
    expect((orphanAfter?.metadata as Record<string, unknown>).cancelled_reason).toBe(
      'fan_out_orphan'
    );
  });

  it('propagates orphan cancellation rollback without completing its parent', async () => {
    await writeWorkflow('fan-child-echo2', fanChildEcho.replace('fan-child', 'fan-child-echo2'));
    await writeWorkflow(
      'fan-i2',
      `
name: fan-i2
description: items shrank between attempts — a child_index falls out of range
nodes:
  - id: plan
    bash: |
      printf '%s' '["only-one"]'
  - id: work
    workflow: fan-child-echo2
    depends_on: [plan]
    isolation: inherit
    fan_out:
      items: "$plan.output"
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-i2');

    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-i2',
      origin: { conversationId: 'conv-db' },
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["only-one"]' },
    });
    // A leftover child at index 5 (items now length 1) still 'running'.
    const orphan = await store.createWorkflowRun({
      workflow_name: 'fan-child-echo2',
      origin: { conversationId: 'conv-db' },
      user_message: 'gone',
      parent_run_id: parentRun.id,
      working_path: join(cwd, 'orphan-wt'),
      metadata: { parent_node_id: 'work', child_index: 5 },
    });
    await store.updateWorkflowRun(orphan.id, { status: 'running' });

    store.cancelFanOutRun = async () => {
      throw new Error('terminal projection read failed');
    };

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    await expect(
      executeWorkflow(
        deps,
        makePlatform(),
        'conv-plat',
        cwd,
        parent,
        'goal',
        { conversationId: 'conv-db' },
        {
          ...hydrated!,
        }
      )
    ).rejects.toThrow('terminal projection read failed');
    expect((await store.getWorkflowRun(parentRun.id))?.status).not.toBe('completed');
    expect((await store.getWorkflowRun(orphan.id))?.status).toBe('running');
  });

  it('a user-cancelled fan-out child (untagged) is NOT resurrected on resume (C2)', async () => {
    await writeWorkflow(
      'fan-child-flaky2',
      `
name: fan-child-flaky2
description: each item fails once then recovers (per-item marker)
nodes:
  - id: run
    bash: |
      test -f "marker-$ARGUMENTS" && printf 'recovered:%s' "$ARGUMENTS" || { touch "marker-$ARGUMENTS"; exit 3; }
`
    );
    await writeWorkflow(
      'fan-c2-usercancel',
      `
name: fan-c2-usercancel
description: a user-cancelled child stays terminal on resume
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b"]'
  - id: work
    workflow: fan-child-flaky2
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
    const parent = await discover('fan-c2-usercancel');
    const { resolver } = makeFanResolver(cwd);

    // Concurrent, and deterministic without pinning: nothing cancels a sibling any more, so
    // both children fail their own first pass and index 0 is unambiguously a plain 'failed'
    // child for the user-cancel below. (Pinned to max_parallel: 1 while the fail-fast could
    // tag whichever child lost the race as `fan_out_sibling`, which IS recoverable — the
    // test would then have asserted the opposite of its own subject.)
    //
    // Run 1: both children fail their first pass → the node fails.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      { conversationId: 'conv-db' },
      { resolveChildIsolation: resolver }
    );
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-c2-usercancel');
    const childA = [...store.runs.values()].find(
      r =>
        r.workflow_name === 'fan-child-flaky2' &&
        (r.metadata as Record<string, unknown>).child_index === 0
    );
    // Precondition, asserted so a regression can't silently change the subject: index 0
    // failed on its own and carries no fan-out cancel tag.
    expect(childA?.status).toBe('failed');
    expect((childA?.metadata as Record<string, unknown>).cancelled_reason).toBeUndefined();
    // User cancels child A out-of-band (a failed child → cancellable; no fan-out tag).
    await store.cancelWorkflowRun(childA!.id, { cancel_reason: 'operator' });
    expect((await store.getWorkflowRun(childA!.id))?.status).toBe('cancelled');

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
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    // The untagged user-cancel is terminal → node still fails; child A is NOT resurrected.
    expect(r2.success).toBe(false);
    const childAafter = await store.getWorkflowRun(childA!.id);
    expect(childAafter?.status).toBe('cancelled');
    expect((childAafter?.metadata as Record<string, unknown>).cancelled_reason).toBeUndefined();
    const failed = store.events
      .filter(e => e.event_type === 'node_failed' && e.step_name === 'work')
      .at(-1);
    expect(failed?.data?.fan_out_outcome).toMatchObject({
      slots: [
        {
          index: 0,
          outcome: 'cancelled_out_of_band',
          child_run_id: childA!.id,
          cancel_reason: 'operator',
        },
        { index: 1, outcome: 'completed' },
      ],
    });
    // Exactly one row for index 0 — never re-driven.
    expect(
      [...store.runs.values()].filter(
        r =>
          r.workflow_name === 'fan-child-flaky2' &&
          (r.metadata as Record<string, unknown>).child_index === 0
      )
    ).toHaveLength(1);
  });

  it('a failed child does NOT cancel its in-flight siblings', async () => {
    // The inverse of the fail-fast this replaced. "fail" exits instantly while the others
    // sleep, so at the moment the failure lands its siblings are genuinely mid-flight —
    // exactly the window the old cooperative cancel fired in.
    await writeWorkflow(
      'fan-child-slowfail',
      `
name: fan-child-slowfail
description: instant fail on "fail"; a slow success otherwise
mutates_checkout: false
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "fail" ]; then exit 3; fi
      sleep 0.2
      printf 'ok:%s' "$ARGUMENTS"
`
    );
    await writeWorkflow(
      'fan-i1',
      `
name: fan-i1
description: an early failure leaves its siblings alone
nodes:
  - id: plan
    bash: |
      printf '%s' '["fail","slow1","slow2"]'
  - id: work
    workflow: fan-child-slowfail
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-i1');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    // The node still fails under all_success — the outcome is unchanged, only the means.
    expect(result.success).toBe(false);
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-slowfail');
    expect(children).toHaveLength(3);
    const byIndex = new Map(
      children.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect(byIndex.get(0)?.status).toBe('failed');
    // The siblings finished their own sleep and completed. Nothing cancelled them, and no
    // `fan_out_sibling` tag is written any more.
    for (const i of [1, 2]) {
      expect(byIndex.get(i)?.status).toBe('completed');
      expect(
        (byIndex.get(i)?.metadata as Record<string, unknown>).cancelled_reason
      ).toBeUndefined();
    }
  });

  it('the all_success failure names the failing child when it is not the first item', async () => {
    // Successor to a test that needed marker-file choreography to put fail-fast casualties
    // BELOW the real failure. With no fail-fast there are no casualties, so the scenario
    // needs no ordering at all: children 0 and 1 simply succeed and child 2 fails.
    await writeWorkflow('fan-child-cond', fanChildCond);
    await writeWorkflow(
      'fan-causal',
      `
name: fan-causal
description: the failing child sits at the highest index
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b","boom"]'
  - id: work
    workflow: fan-child-cond
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-causal');
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', {
      conversationId: 'conv-db',
    });

    expect(result.success).toBe(false);
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-cond');
    const byIndex = new Map(
      children.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect(byIndex.get(0)?.status).toBe('completed');
    expect(byIndex.get(1)?.status).toBe('completed');
    expect(byIndex.get(2)?.status).toBe('failed');

    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    const error = String(nodeFailed?.data?.error);
    // The only non-completed outcome is the real failure, so the lowest-index bad one IS
    // the causal one — which is why the causal-selection helper could be deleted.
    expect(error).toContain('child 2');
    expect(error).not.toContain('child 0');
    expect(error).not.toContain('child 1');
  });
});
