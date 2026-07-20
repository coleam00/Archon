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
});
