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
import { mkdir, writeFile, rm, cp } from 'fs/promises';
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

/**
 * Fan-out child-isolation resolver (slice 2, PR-C): gives each child a DISTINCT
 * worktree keyed by childIndex (so N concurrent siblings don't collide on the path
 * lock) and copies the repo's `.archon` into it so the child can still discover its
 * own target workflow from the isolated checkout. Records the requests it saw.
 */
function makeFanResolver(root: string): {
  resolver: ChildIsolationResolver;
  calls: ChildIsolationRequest[];
} {
  const calls: ChildIsolationRequest[] = [];
  const resolver: ChildIsolationResolver = {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      calls.push(req);
      const idx = req.childIndex ?? 0;
      const dir = join(root, 'wt', `${req.parentRun.id}-child-${String(idx)}`);
      await mkdir(dir, { recursive: true });
      await cp(join(root, '.archon'), join(dir, '.archon'), { recursive: true });
      return {
        cwd: dir,
        envId: `env-${req.parentRun.id.slice(0, 8)}-${String(idx)}`,
        branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-${String(idx)}`,
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

  it('threads the resolver into a nested child so a grandchild also isolates (I1)', async () => {
    // parent → child-mid → grandchild-iso, all `isolation: worktree`. Without the
    // resolver being threaded into the child's own executeWorkflow opts, the
    // grandchild spawn would fail-fast "requires an injected resolver".
    await writeWorkflow(
      'grandchild-iso',
      `
name: grandchild-iso
description: bottom of a nested isolation chain
nodes:
  - id: work
    prompt: "grandchild does $ARGUMENTS"
`
    );
    await writeWorkflow(
      'child-mid',
      `
name: child-mid
description: middle link that isolates its own child
nodes:
  - id: sub
    workflow: grandchild-iso
    input: "y"
    isolation: worktree
`
    );
    await writeWorkflow(
      'parent-nested',
      `
name: parent-nested
description: top of a nested isolation chain
nodes:
  - id: sub
    workflow: child-mid
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-nested');

    // Resolver returns a distinct worktree per parent run and copies the repo's
    // `.archon` (workflows) into it — a real worktree is a checkout of the same repo,
    // so the nested grandchild target stays discoverable from the child's worktree.
    const calls: ChildIsolationRequest[] = [];
    const resolver: ChildIsolationResolver = {
      async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
        calls.push(req);
        const dir = join(cwd, 'wt', `${req.parentRun.id}-child-${String(req.childIndex ?? 0)}`);
        await mkdir(dir, { recursive: true });
        await cp(join(cwd, '.archon'), join(dir, '.archon'), { recursive: true });
        return {
          cwd: dir,
          envId: `env-${String(calls.length)}`,
          branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-0`,
        };
      },
    };

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
    // Both levels invoked the resolver (proving it propagated to the grandchild).
    expect(calls).toHaveLength(2);
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-mid');
    const grandchild = [...store.runs.values()].find(r => r.workflow_name === 'grandchild-iso');
    expect(child?.status).toBe('completed');
    expect(grandchild?.status).toBe('completed');
    // Three distinct checkouts: parent (shared), child worktree, grandchild worktree.
    expect(child?.working_path).not.toBe(cwd);
    expect(grandchild?.working_path).not.toBe(cwd);
    expect(grandchild?.working_path).not.toBe(child?.working_path);
    // The child records its own worktree env + branch in metadata (S3).
    expect((child?.metadata as Record<string, unknown>).isolation_env_id).toBeDefined();
    expect(String((child?.metadata as Record<string, unknown>).branch_name)).toContain(
      'archon/task-'
    );
  });

  it('a resolver that throws fails the node cleanly with no orphan child (I5)', async () => {
    await writeWorkflow(
      'child-iso',
      `
name: child-iso
description: child wanting its own worktree
nodes:
  - id: work
    prompt: "do work for $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-iso-throw',
      `
name: parent-iso-throw
description: parent whose resolver blows up
nodes:
  - id: sub
    workflow: child-iso
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso-throw');
    const resolver: ChildIsolationResolver = {
      resolve: () => Promise.reject(new Error('no space left on device')),
    };

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

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-iso-throw');
    expect(parentRun?.status).toBe('failed');
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'sub'
    );
    // Sub-run context prefix + the propagated resolver error (classification is the
    // real resolver's job; the fake surfaces the raw message unchanged).
    expect(String(nodeFailed?.data?.error)).toContain('Failed to create isolated worktree');
    expect(String(nodeFailed?.data?.error)).toContain('no space left on device');
    // No orphan child row — the fail happens before createWorkflowRun.
    expect([...store.runs.values()].filter(r => r.parent_run_id !== null)).toHaveLength(0);
  });

  it('resume with a pruned child worktree fails cleanly, not a deep ENOENT (I2)', async () => {
    // Child fails on its first pass so the parent has a resumable failed child; then
    // its worktree is deleted (as `isolation cleanup` would) before the parent resume.
    await writeWorkflow(
      'child-iso-fail',
      `
name: child-iso-fail
description: isolated child that fails first
nodes:
  - id: boom
    bash: "exit 3"
`
    );
    await writeWorkflow(
      'parent-iso-resume',
      `
name: parent-iso-resume
description: parent whose isolated child worktree gets pruned
nodes:
  - id: sub
    workflow: child-iso-fail
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-iso-resume');
    const childCwd = join(cwd, 'wt', 'pruned-child');
    const { resolver } = makeFakeResolver(childCwd);

    // First drive: resolver creates the worktree, child `exit 3` fails, parent fails.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { resolveChildIsolation: resolver }
    );
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-iso-resume');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-iso-fail');
    expect(child?.status).toBe('failed');
    expect(child?.working_path).toBe(childCwd);

    // Prune the child's worktree, then resume the parent.
    await rm(childCwd, { recursive: true, force: true });
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
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    expect(r2.success).toBe(false);
    // Clean, actionable message — not a raw ENOENT from executing in a vanished dir.
    const nodeFailed = [...store.events]
      .reverse()
      .find(e => e.event_type === 'node_failed' && e.step_name === 'sub');
    expect(String(nodeFailed?.data?.error)).toContain('working path no longer exists');
    expect(String(nodeFailed?.data?.error)).toContain('cleaned up');
    expect(String(nodeFailed?.data?.error)).not.toContain('ENOENT');
  });

  // --- slice 2, PR-C: dynamic fan-out -------------------------------------------

  /** Child that echoes its per-item $ARGUMENTS, so fan-out aggregate ordering + the
   *  item→$ARGUMENTS channel are both observable. */
  const fanChildEcho = `
name: fan-child
description: echoes its per-item argument
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
      'conv-db',
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-parent');
    expect(parentRun?.status).toBe('completed');

    // Fan-out defaults to per-child worktree isolation: the resolver was called once per
    // item, with distinct child indexes.
    expect(calls).toHaveLength(3);
    expect([...calls.map(c => c.childIndex ?? 0)].sort((a, b) => a - b)).toEqual([0, 1, 2]);

    // Three children, each linked to the parent + the fan-out node, keyed by child_index,
    // each in its OWN worktree (distinct working paths, none the parent's checkout).
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child');
    expect(children).toHaveLength(3);
    for (const c of children) {
      expect(c.parent_run_id).toBe(parentRun?.id);
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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-malformed');
    expect(parentRun?.status).toBe('failed');
    // No children were spawned for an unusable items resolution.
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child')).toHaveLength(0);
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    expect(String(nodeFailed?.data?.error)).toContain('not a JSON array');
  });

  /** Child that succeeds echoing its arg, but fails (exit 3) on the item "boom". */
  const fanChildCond = `
name: fan-child-cond
description: fails on the item "boom", echoes otherwise
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "boom" ]; then exit 3; fi
      printf 'ok:%s' "$ARGUMENTS"
`;

  it('all_success fail-fast (serial): a failed child fails the node and later items are not spawned', async () => {
    await writeWorkflow('fan-child-cond', fanChildCond);
    await writeWorkflow(
      'fan-failfast',
      `
name: fan-failfast
description: one child fails under all_success
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","boom","c"]'
  - id: work
    workflow: fan-child-cond
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 1
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-failfast');
    const { resolver, calls } = makeFanResolver(cwd);
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

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-failfast');
    expect(parentRun?.status).toBe('failed');

    // Serial (max_parallel: 1): index 0 completed, index 1 failed → fail-fast → index 2
    // was NEVER spawned (no child row, resolver never called for it).
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-cond');
    const indexes = children
      .map(c => (c.metadata as Record<string, unknown>).child_index as number)
      .sort((a, b) => a - b);
    expect(indexes).toEqual([0, 1]);
    expect(calls.map(c => c.childIndex ?? 0).sort((a, b) => a - b)).toEqual([0, 1]);
    const byIndex = new Map(
      children.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect(byIndex.get(0)?.status).toBe('completed');
    expect(byIndex.get(1)?.status).toBe('failed');

    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    expect(String(nodeFailed?.data?.error)).toContain('all_success');
    expect(String(nodeFailed?.data?.error)).toContain('child 1');
  });

  it('all_done: a partial failure still completes the node; the failed entry is represented', async () => {
    await writeWorkflow('fan-child-cond', fanChildCond);
    await writeWorkflow(
      'fan-alldone',
      `
name: fan-alldone
description: all_done tolerates a partial failure
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","boom","c"]'
  - id: work
    workflow: fan-child-cond
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
      join: all_done
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-alldone');
    const { resolver } = makeFanResolver(cwd);
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

    // all_done never fails on a partial failure.
    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-alldone');
    expect(parentRun?.status).toBe('completed');
    // All 3 children ran (no fail-fast under all_done).
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child-cond')).toHaveLength(
      3
    );

    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as unknown[];
    expect(aggregate[0]).toBe('ok:a');
    expect(aggregate[2]).toBe('ok:c');
    // The failed middle child is represented as an error object, not dropped.
    expect(aggregate[1]).toMatchObject({ status: 'failed' });
  });

  it('bounds concurrency to max_parallel (sliding window over the children)', async () => {
    await writeWorkflow(
      'fan-child-slow',
      `
name: fan-child-slow
description: one AI turn per child (concurrency observable via the provider)
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
    // Concurrency-tracking provider: the in-flight window during the awaited "AI turn"
    // reflects how many children run at once.
    const tracker = { inFlight: 0, max: 0 };
    const slowProvider = {
      ...makeProvider(),
      sendQuery: async function* () {
        tracker.inFlight++;
        tracker.max = Math.max(tracker.max, tracker.inFlight);
        await new Promise(r => setTimeout(r, 15));
        tracker.inFlight--;
        yield { type: 'assistant', content: 'ai-output' };
        yield { type: 'result', sessionId: 'sess', cost: 0.01 };
      },
    };
    const deps = {
      ...makeDeps(store),
      getAgentProvider: mock(() => slowProvider) as unknown as WorkflowDeps['getAgentProvider'],
    };
    const parent = await discover('fan-window');
    const { resolver } = makeFanResolver(cwd);
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
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child-slow')).toHaveLength(
      5
    );
    // Never more than max_parallel children in flight at once, and the window IS used
    // (two ran concurrently — proving it isn't accidentally serial).
    expect(tracker.max).toBe(2);
  });

  it('rolls up child cost onto the fan-out node (Σ child costs → parent total)', async () => {
    await writeWorkflow(
      'fan-child-cost',
      `
name: fan-child-cost
description: one AI turn (canned cost 0.01) per child
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
  - id: plan
    bash: |
      printf '%s' '["a","b","c"]'
  - id: work
    workflow: fan-child-cost
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-cost');
    const { resolver } = makeFanResolver(cwd);
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
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-cost');
    // 3 children × 0.01 each = 0.03 rolled up to the parent (plan is bash → 0 cost).
    expect((parentRun?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.03, 5);
  });

  it('parent resume re-drives only the failed instance, skipping completed ones (1:N re-entry)', async () => {
    await writeWorkflow(
      'fan-child-flaky',
      `
name: fan-child-flaky
description: the "flaky" item fails once then recovers; others always succeed
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
    await writeWorkflow(
      'fan-resume',
      `
name: fan-resume
description: one flaky instance recovers on parent resume
nodes:
  - id: plan
    bash: |
      printf '%s' '["keep0","flaky","keep2"]'
  - id: work
    workflow: fan-child-flaky
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-resume');
    const { resolver } = makeFanResolver(cwd);

    // First drive: the flaky child (index 1) fails → node fails under all_success.
    const r1 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { resolveChildIsolation: resolver }
    );
    expect(r1.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-resume');
    const children1 = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-flaky');
    expect(children1).toHaveLength(3);
    const byIndex1 = new Map(
      children1.map(c => [(c.metadata as Record<string, unknown>).child_index as number, c])
    );
    expect(byIndex1.get(0)?.status).toBe('completed');
    expect(byIndex1.get(1)?.status).toBe('failed');
    expect(byIndex1.get(2)?.status).toBe('completed');

    // Resume the PARENT: only the failed index-1 child is re-driven (marker now present →
    // recovered); the two completed siblings are threaded from their rows, NOT re-run.
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
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    expect(r2.success).toBe(true);
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('completed');
    // Still exactly 3 child rows — the failed one was re-driven in place, not duplicated.
    expect(
      [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-flaky')
    ).toHaveLength(3);
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(JSON.parse(String(workCompleted?.data?.node_output))).toEqual([
      'ok:keep0',
      'recovered',
      'ok:keep2',
    ]);
  });

  it('a fan-out child that pauses at a gate FAILS the node (#2180) and is cancelled', async () => {
    await writeWorkflow(
      'fan-child-gated',
      `
name: fan-child-gated
description: a fan-out child with an approval gate (illegal — fan-out is autonomous)
interactive: true
nodes:
  - id: impl
    prompt: "implement $ARGUMENTS"
  - id: gate
    approval:
      message: "review the fan-out child"
    depends_on: [impl]
`
    );
    await writeWorkflow(
      'fan-gated-parent',
      `
name: fan-gated-parent
description: fans out over a gated child
interactive: true
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b"]'
  - id: work
    workflow: fan-child-gated
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 2
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-gated-parent');
    const { resolver } = makeFanResolver(cwd);
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

    expect(result.success).toBe(false);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-gated-parent');
    expect(parentRun?.status).toBe('failed');
    // The parent must NOT be paused blocked-on-child — a fan-out node never holds the
    // single gate slot (#2180); it fails instead.
    expect((parentRun?.metadata as Record<string, unknown>).approval).toBeUndefined();

    // Every fan-out child that paused was cancelled (cooperative), not left hanging.
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-gated');
    expect(children.length).toBeGreaterThanOrEqual(1);
    for (const c of children) {
      expect(c.status).toBe('cancelled');
    }
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    expect(String(nodeFailed?.data?.error)).toContain('autonomously');
    expect(String(nodeFailed?.data?.error)).toContain('#2180');
  });
});
