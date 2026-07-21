/**
 * End-to-end tests for the `workflow:` sub-run primitive (#2121 Phase 2).
 *
 * These drive the REAL executor recursion — executeWorkflow → runChildWorkflow
 * closure → executeDagWorkflow → executeWorkflowNode → child executeWorkflow — with
 * a stateful in-memory store, a canned AI provider, and real workflow files on disk
 * (so runChildWorkflow's discovery/resolveWorkflowName and the parent auto-resume
 * hook both work against real definitions).
 *
 * MUST run in its own `bun test` invocation (package.json): it deliberately does
 * NOT mock ./dag-executor, so it cannot share a process with executor.test.ts,
 * which does (mock.module is process-global and irreversible).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock logger + telemetry (passthrough real path utilities like loader.test.ts) ---
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
  captureWorkflowInvoked: mock(() => {}),
  captureWorkflowCompleted: mock(() => {}),
  captureApprovalResolved: mock(() => {}),
}));

// --- Mock git (no real repo needed) ---
mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// --- Bootstrap provider registry (load-time isRegisteredProvider checks) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

import { executeWorkflow, hydrateResumableRun } from './executor';
import { discoverWorkflows } from './workflow-discovery';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowRun } from './schemas/workflow-run';
import type { WorkflowDefinition } from './schemas/workflow';
import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from './child-isolation';

// ---------------------------------------------------------------------------
// Stateful in-memory store — implements just enough of IWorkflowStore to drive
// the real run lifecycle (create / pause / resume / complete / fail / cancel),
// event log (for getCompletedDagNodeOutputs), the run tree (findChildRuns /
// getRunAncestry), and the ancestor-aware path lock.
// ---------------------------------------------------------------------------

interface StoreEvent {
  workflow_run_id: string;
  event_type: string;
  step_name?: string;
  data?: Record<string, unknown>;
}

class InMemoryStore implements IWorkflowStore {
  runs = new Map<string, WorkflowRun>();
  events: StoreEvent[] = [];
  private seq = 0;

  private clone(r: WorkflowRun): WorkflowRun {
    return { ...r, metadata: { ...r.metadata } };
  }

  createWorkflowRun: IWorkflowStore['createWorkflowRun'] = data => {
    const id = `run-${String(++this.seq)}`;
    const row: WorkflowRun = {
      id,
      workflow_name: data.workflow_name,
      conversation_id: data.conversation_id,
      parent_conversation_id: data.parent_conversation_id ?? null,
      codebase_id: data.codebase_id ?? null,
      status: 'pending',
      user_message: data.user_message,
      metadata: data.metadata ?? {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: new Date(),
      working_path: data.working_path ?? null,
      user_id: data.user_id ?? null,
      parent_run_id: data.parent_run_id ?? null,
    };
    this.runs.set(id, row);
    return Promise.resolve(this.clone(row));
  };

  getWorkflowRun = (id: string): Promise<WorkflowRun | null> => {
    const r = this.runs.get(id);
    return Promise.resolve(r ? this.clone(r) : null);
  };

  findChildRuns = (parentRunId: string): Promise<WorkflowRun[]> =>
    Promise.resolve(
      [...this.runs.values()].filter(r => r.parent_run_id === parentRunId).map(r => this.clone(r))
    );

  getRunAncestry = (runId: string): Promise<WorkflowRun[]> => {
    const out: WorkflowRun[] = [];
    const seen = new Set([runId]);
    let cur = this.runs.get(runId);
    while (cur?.parent_run_id && !seen.has(cur.parent_run_id)) {
      const parent = this.runs.get(cur.parent_run_id);
      if (!parent) break;
      out.push(this.clone(parent));
      seen.add(parent.id);
      cur = parent;
    }
    return Promise.resolve(out);
  };

  getActiveWorkflowRunByPath = (
    workingPath: string,
    self?: { id: string; startedAt: Date; excludeRunIds?: string[] }
  ): Promise<WorkflowRun | null> => {
    const exclude = new Set([self?.id, ...(self?.excludeRunIds ?? [])].filter(Boolean));
    const active = [...this.runs.values()]
      .filter(
        r =>
          r.working_path === workingPath &&
          (r.status === 'running' || r.status === 'paused' || r.status === 'pending') &&
          !exclude.has(r.id)
      )
      .sort((a, b) => a.started_at.getTime() - b.started_at.getTime());
    return Promise.resolve(active[0] ? this.clone(active[0]) : null);
  };

  resumeWorkflowRun = (id: string): Promise<WorkflowRun> => {
    const r = this.runs.get(id);
    if (!r) throw new Error(`no run ${id}`);
    r.status = 'running';
    return Promise.resolve(this.clone(r));
  };

  updateWorkflowRun: IWorkflowStore['updateWorkflowRun'] = (id, updates) => {
    const r = this.runs.get(id);
    if (r) {
      if (updates.status) r.status = updates.status;
      if (updates.metadata) r.metadata = { ...r.metadata, ...updates.metadata };
    }
    return Promise.resolve();
  };

  updateWorkflowActivity = (): Promise<void> => Promise.resolve();

  getWorkflowRunStatus = (id: string): Promise<WorkflowRun['status'] | null> =>
    Promise.resolve(this.runs.get(id)?.status ?? null);

  completeWorkflowRun: IWorkflowStore['completeWorkflowRun'] = (id, metadata) => {
    const r = this.runs.get(id);
    if (r) {
      r.status = 'completed';
      r.completed_at = new Date();
      if (metadata) r.metadata = { ...r.metadata, ...metadata };
    }
    return Promise.resolve();
  };

  failWorkflowRun = (id: string, error: string): Promise<void> => {
    const r = this.runs.get(id);
    if (r) {
      r.status = 'failed';
      r.completed_at = new Date();
      r.metadata = { ...r.metadata, error };
    }
    return Promise.resolve();
  };

  pauseWorkflowRun: IWorkflowStore['pauseWorkflowRun'] = (id, approvalContext, extraMetadata) => {
    const r = this.runs.get(id);
    if (r) {
      r.status = 'paused';
      r.metadata = {
        ...r.metadata,
        approval: { ...approvalContext, resolved: null },
        ...(extraMetadata ?? {}),
      };
    }
    return Promise.resolve();
  };

  claimWriteback = (): Promise<{ claimed: boolean }> => Promise.resolve({ claimed: true });
  releaseWritebackClaim = (): Promise<void> => Promise.resolve();

  cancelWorkflowRun = (id: string): Promise<{ cancelled: boolean }> => {
    const r = this.runs.get(id);
    if (r && r.status !== 'completed' && r.status !== 'cancelled') {
      r.status = 'cancelled';
      r.completed_at = new Date();
      return Promise.resolve({ cancelled: true });
    }
    return Promise.resolve({ cancelled: false });
  };

  createWorkflowEvent: IWorkflowStore['createWorkflowEvent'] = data => {
    this.events.push(data);
    return Promise.resolve();
  };

  getCompletedDagNodeOutputs = (workflowRunId: string): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    for (const e of this.events) {
      if (
        e.workflow_run_id === workflowRunId &&
        (e.event_type === 'node_completed' || e.event_type === 'node_skipped_prior_success') &&
        typeof e.step_name === 'string'
      ) {
        map.set(e.step_name, String(e.data?.node_output ?? ''));
      }
    }
    return Promise.resolve(map);
  };

  getCodebase = (): Promise<null> => Promise.resolve(null);
  getCodebaseEnvVars = (): Promise<Record<string, string>> => Promise.resolve({});
  getWorkflowNodeSession = (): Promise<null> => Promise.resolve(null);
  upsertWorkflowNodeSession = (): Promise<void> => Promise.resolve();
  deleteWorkflowNodeSessions = (): Promise<{ deleted: number }> => Promise.resolve({ deleted: 0 });
  findResumableRun = (): Promise<null> => Promise.resolve(null);
  failOrphanedRuns = (): Promise<{ count: number }> => Promise.resolve({ count: 0 });

  // --- test helpers ---
  /** Mimic approveWorkflow for a standard approval gate: write node_completed for
   *  the gate node + stamp approval.resolved='approved'. */
  approveGate(runId: string): void {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`no run ${runId}`);
    const approval = r.metadata.approval as Record<string, unknown> | undefined;
    const nodeId = approval?.nodeId as string;
    this.events.push({
      workflow_run_id: runId,
      event_type: 'node_completed',
      step_name: nodeId,
      data: { node_output: '', approval_decision: 'approved' },
    });
    r.metadata = { ...r.metadata, approval: { ...(approval ?? {}), resolved: 'approved' } };
  }
}

// --- Canned AI provider: every prompt node yields the same output + a small cost ---
function makeProvider() {
  return {
    getType: () => 'claude',
    getCapabilities: () => ({
      sessionResume: true,
      mcp: true,
      hooks: true,
      skills: true,
      agents: true,
      toolRestrictions: true,
      structuredOutput: 'enforced' as const,
      envInjection: true,
      costControl: true,
      effortControl: true,
      thinkingControl: true,
      fallbackModel: true,
      sandbox: true,
    }),
    sendQuery: mock(function* () {
      yield { type: 'assistant', content: 'ai-output' };
      yield { type: 'result', sessionId: 'sess', cost: 0.01 };
    }),
  };
}

function makeDeps(store: IWorkflowStore): WorkflowDeps {
  return {
    store,
    getAgentProvider: mock(() => makeProvider()) as unknown as WorkflowDeps['getAgentProvider'],
    loadConfig: mock(
      (): Promise<WorkflowConfig> =>
        Promise.resolve({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        })
    ),
  };
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

/**
 * Fake child-isolation resolver (slice 2, PR-A). Records the requests it receives
 * and returns a fixed per-child cwd, creating it on disk so the child's
 * executeWorkflow (artifacts/logs) has a real directory — a real worktree IS a
 * real checkout.
 */
function makeFakeResolver(childCwd: string): {
  resolver: ChildIsolationResolver;
  calls: ChildIsolationRequest[];
} {
  const calls: ChildIsolationRequest[] = [];
  const resolver: ChildIsolationResolver = {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      calls.push(req);
      await mkdir(childCwd, { recursive: true });
      return {
        cwd: childCwd,
        envId: `env-${String(req.childIndex ?? 0)}`,
        branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-${String(req.childIndex ?? 0)}`,
      };
    },
  };
  return { resolver, calls };
}

describe('workflow: sub-run e2e (#2121 Phase 2)', () => {
  let cwd: string;
  const originalArchonHome = process.env.ARCHON_HOME;

  async function writeWorkflow(name: string, yaml: string): Promise<void> {
    await writeFile(join(cwd, '.archon', 'workflows', `${name}.yaml`), yaml);
  }

  async function discover(name: string): Promise<WorkflowDefinition> {
    const result = await discoverWorkflows(cwd, { loadDefaults: false });
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
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  it('runs a gateless child synchronously, threads output + cost, links parent_run_id', async () => {
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
      'conv-db'
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
    // Child row exists, linked to the parent + node.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-plain');
    expect(child).toBeDefined();
    expect(child?.parent_run_id).toBe(parentRun?.id);
    expect((child?.metadata as Record<string, unknown>).parent_node_id).toBe('sub');
    expect(child?.status).toBe('completed');
    // Child persisted its terminal summary + cost for the parent to read back.
    expect((child?.metadata as Record<string, unknown>).summary).toBe('ai-output');
    expect((child?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.01, 5);
    // The sub node wrote node_completed with the child's output (threaded to $sub.output).
    const subCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'sub'
    );
    expect(subCompleted?.data?.node_output).toBe('ai-output');
    // Child conversation is shared with the parent.
    expect(child?.conversation_id).toBe('conv-db');
  });

  it('child gate → parent pauses blocked-on-child → approve child → parent auto-resumes → output threads', async () => {
    await writeWorkflow(
      'child-gated',
      `
name: child-gated
description: child with an approval gate
interactive: true
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
interactive: true
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
    const deps = makeDeps(store);
    const parent = await discover('parent-gated');

    // First drive: parent runs, child pauses at its gate, parent pauses on child.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );
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
      'conv-db',
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

  it('a throw during the parent auto-resume pass lands the parent in failed, never wedged at running', async () => {
    await writeWorkflow(
      'child-gated',
      `
name: child-gated
description: child with an approval gate
interactive: true
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
interactive: true
nodes:
  - id: sub
    workflow: child-gated
    input: "goal"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-gated');
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', 'conv-db');

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
      'conv-db',
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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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
    const result = await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, a, 'g', 'conv-db');

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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      top,
      'g',
      'conv-db'
    );

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
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-recover');
    const child1 = [...store.runs.values()].find(r => r.workflow_name === 'child-flaky');
    expect(parentRun?.status).toBe('failed');
    expect(child1?.status).toBe('failed');

    // Resume the PARENT: re-entry finds the failed child and re-drives it once
    // (resumeFailedChild), the marker now exists so the child completes, and the
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
      'conv-db',
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
    const p2r1 = await executeWorkflow(
      deps2,
      makePlatform(),
      'conv-plat',
      cwd,
      parent2,
      'goal',
      'conv-db'
    );
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
      'conv-db',
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

  it('a throw during the child spawn does NOT leave a non-terminal zombie child (I1)', async () => {
    await writeWorkflow(
      'child-plain',
      `
name: child-plain
description: child with no gate
nodes:
  - id: work
    prompt: "do work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-plain',
      `
name: parent-plain
description: parent that spawns a child
nodes:
  - id: sub
    workflow: child-plain
    input: "x"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    // The child inherits the parent's codebase_id, so its executeWorkflow early setup
    // calls getCodebaseEnvVars. Make the SECOND call (the child's — the parent's is
    // first) throw, sabotaging the child's setup BEFORE its own status→running flip
    // and catch-all. Without the wedge guard the pre-created child stays 'pending',
    // holding the path lock.
    let envCalls = 0;
    store.getCodebaseEnvVars = () => {
      envCalls++;
      return envCalls >= 2 ? Promise.reject(new Error('env lookup exploded')) : Promise.resolve({});
    };

    const parent = await discover('parent-plain');
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { codebaseId: 'cb-1' }
    );

    expect(result.success).toBe(false);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-plain');
    expect(child).toBeDefined();
    // The child must be TERMINAL — not a 'pending'/'running' zombie holding the lock.
    expect(['cancelled', 'failed']).toContain(child?.status);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-plain');
    expect(parentRun?.status).toBe('failed');
  });

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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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
interactive: true
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
interactive: true
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
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', 'conv-db');
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
      'conv-db',
      { ...hydrated! }
    );

    // Parent re-paused; child untouched (still paused, still one run, no new events).
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('paused');
    expect((await store.getWorkflowRun(child!.id))?.status).toBe('paused');
    expect([...store.runs.values()].filter(r => r.workflow_name === 'child-gated')).toHaveLength(1);
    const childEventsAfter = store.events.filter(e => e.workflow_run_id === child!.id).length;
    expect(childEventsAfter).toBe(childEventsBefore); // child was NOT re-driven
  });

  it('fails cleanly with "Unknown sub-run workflow" on a typo\'d target (S5)', async () => {
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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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
  });

  // --- slice 2, PR-A: per-child worktree isolation ------------------------------

  it("isolation: 'worktree' runs the child in the resolver's cwd (distinct from the parent)", async () => {
    await writeWorkflow(
      'child-iso',
      `
name: child-iso
description: child that runs in its own worktree
nodes:
  - id: work
    prompt: "do the work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-iso',
      `
name: parent-iso
description: parent that isolates its child
nodes:
  - id: sub
    workflow: child-iso
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso');
    const childCwd = join(cwd, 'child-worktree-0');
    const { resolver, calls } = makeFakeResolver(childCwd);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    // The resolver was invoked once, for the `sub` node, carrying the parent run.
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeId).toBe('sub');
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-iso');
    expect(calls[0].parentRun.id).toBe(parentRun?.id);
    // The child ran in the resolver's worktree cwd — NOT the parent's checkout.
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-iso');
    expect(child?.status).toBe('completed');
    expect(child?.working_path).toBe(childCwd);
    expect(child?.working_path).not.toBe(cwd);
  });

  it("isolation: 'worktree' with NO resolver injected fails the node fast (no shared-checkout fallback)", async () => {
    await writeWorkflow(
      'child-iso',
      `
name: child-iso
description: child that wants its own worktree
nodes:
  - id: work
    prompt: "do work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-iso-noresolver',
      `
name: parent-iso-noresolver
description: parent requesting worktree isolation with no resolver wired
nodes:
  - id: sub
    workflow: child-iso
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso-noresolver');

    // No resolveChildIsolation in opts — the node must fail fast, never silently
    // fall back to the parent's shared checkout.
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'parent-iso-noresolver'
    );
    expect(parentRun?.status).toBe('failed');
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'sub'
    );
    expect(String(nodeFailed?.data?.error)).toContain('requires an injected');
    // Fail-fast happens BEFORE the child row is created — no orphan child.
    expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
  });

  it("isolation: 'inherit' (and default) shares the parent's checkout — resolver untouched", async () => {
    await writeWorkflow(
      'child-share',
      `
name: child-share
description: child sharing the parent checkout
nodes:
  - id: work
    prompt: "do work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-inherit',
      `
name: parent-inherit
description: parent whose child inherits the checkout
nodes:
  - id: sub
    workflow: child-share
    input: "x"
    isolation: inherit
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-inherit');
    const { resolver, calls } = makeFakeResolver(join(cwd, 'should-not-be-used'));

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    // Even with a resolver available, `inherit` must NOT call it.
    expect(calls).toHaveLength(0);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-share');
    expect(child?.status).toBe('completed');
    // The child shares the parent's checkout.
    expect(child?.working_path).toBe(cwd);
  });
});
