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
import { validateWorkflowResources } from './validator';
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
// event log (for DAG resume snapshots), the run tree (findChildRuns /
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
    // Mirror the real store's CAS guard (`WHERE status = 'running'`): a run cancelled
    // mid-flight (e.g. a fan-out sibling cooperatively cancelled) must NOT be flipped
    // back to completed when its own execution finishes.
    if (r && r.status === 'running') {
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

  getDagResumeSnapshot: IWorkflowStore['getDagResumeSnapshot'] = workflowRunId => {
    const completedNodeOutputs = new Map<string, string>();
    const tokens = { input: 0, output: 0 };
    for (const e of this.events) {
      if (
        e.workflow_run_id === workflowRunId &&
        (e.event_type === 'node_completed' || e.event_type === 'node_skipped_prior_success') &&
        typeof e.step_name === 'string'
      ) {
        completedNodeOutputs.set(e.step_name, String(e.data?.node_output ?? ''));
        const eventTokens = e.data?.tokens;
        if (
          e.event_type === 'node_completed' &&
          typeof eventTokens === 'object' &&
          eventTokens !== null &&
          'input' in eventTokens &&
          'output' in eventTokens &&
          typeof eventTokens.input === 'number' &&
          typeof eventTokens.output === 'number' &&
          Number.isFinite(eventTokens.input) &&
          Number.isFinite(eventTokens.output)
        ) {
          tokens.input += eventTokens.input;
          tokens.output += eventTokens.output;
        }
      }
    }
    return Promise.resolve({ completedNodeOutputs, tokens });
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
      yield { type: 'result', sessionId: 'sess', cost: 0.01, tokens: { input: 7, output: 3 } };
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
    expect((child?.metadata as Record<string, unknown>).total_tokens_in).toBe(7);
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
    expect(subCompleted?.data?.tokens).toEqual({ input: 7, output: 3 });
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

  it('resume of a child row with a NULL working path fails instead of falling back to the parent checkout', async () => {
    // `working_path` is nullable in the schema. Falling back to the parent's cwd here
    // would be the one silent shared-checkout fallback left in runChildWorkflow — and
    // for a child the author isolated on purpose, that is exactly the concurrent-write
    // collision the isolation was requested to prevent. Not reachable through normal
    // creation (every child row gets a real path), so this pins the guard directly.
    await writeWorkflow(
      'child-null-path',
      `
name: child-null-path
description: isolated child whose row loses its working path
nodes:
  - id: boom
    bash: "exit 3"
`
    );
    await writeWorkflow(
      'parent-null-path',
      `
name: parent-null-path
description: parent resuming a child with no recorded checkout
nodes:
  - id: sub
    workflow: child-null-path
    input: "x"
    isolation: worktree
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-null-path');
    const { resolver } = makeFakeResolver(join(cwd, 'wt', 'null-path-child'));

    // First drive: the child fails, leaving the parent a resumable failed child.
    await executeWorkflow(deps, makePlatform(), 'conv-plat', cwd, parent, 'goal', 'conv-db', {
      resolveChildIsolation: resolver,
    });
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-null-path');
    const child = [...store.runs.values()].find(r => r.workflow_name === 'child-null-path');
    expect(child?.status).toBe('failed');

    // Erase the recorded checkout, then resume the parent.
    store.runs.get(child!.id)!.working_path = null;
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun!.id))!);
    const resumeOpts = hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun!.id) };
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
    const nodeFailed = [...store.events]
      .reverse()
      .find(e => e.event_type === 'node_failed' && e.step_name === 'sub');
    expect(String(nodeFailed?.data?.error)).toContain('no recorded working path');
    // The child must NOT have been re-run in the parent's checkout.
    expect((await store.getWorkflowRun(child!.id))?.working_path).not.toBe(cwd);
  });

  it('a parent auto-resumed after a gated isolated child can still isolate its NEXT child', async () => {
    // The flagship shape: isolated `implement` → the child's approval gate → approve →
    // the parent auto-resumes → isolated `review`. The second spawn is the regression:
    // maybeResumeParentRun re-enters executeWorkflow, and until the resolver was
    // threaded into it that re-entry ran resolver-less, so `review` failed with
    // "requires an injected child-isolation resolver" — on a git repo, via the CLI,
    // with the resolver correctly wired at the top. The observable is the parent
    // completing with BOTH children isolated, not merely "nothing threw".
    await writeWorkflow(
      'child-gated-iso',
      `
name: child-gated-iso
description: isolated child that pauses at a gate
interactive: true
nodes:
  - id: implement
    prompt: "implement $ARGUMENTS"
  - id: gate
    approval:
      message: "review the sub-run"
    depends_on: [implement]
  - id: wrap-up
    prompt: "summarize"
    depends_on: [gate]
`
    );
    await writeWorkflow(
      'child-review-iso',
      `
name: child-review-iso
description: isolated child that reviews what the first one built
nodes:
  - id: review
    prompt: "review $ARGUMENTS"
`
    );
    await writeWorkflow(
      'parent-gated-iso',
      `
name: parent-gated-iso
description: isolated implement, gate, isolated review
interactive: true
nodes:
  - id: implement
    workflow: child-gated-iso
    input: "build it"
    isolation: worktree
  - id: review
    workflow: child-review-iso
    input: "$implement.output"
    isolation: worktree
    depends_on: [implement]
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('parent-gated-iso');

    // One worktree per (parent run, node) — the shape buildChildIdentifier produces.
    const calls: ChildIsolationRequest[] = [];
    const resolver: ChildIsolationResolver = {
      async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
        calls.push(req);
        const dir = join(cwd, 'wt', `${req.parentRun.id}-${req.nodeId}`);
        await mkdir(dir, { recursive: true });
        return {
          cwd: dir,
          envId: `env-${req.nodeId}`,
          branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-${req.nodeId}-child-0`,
        };
      },
    };

    // First drive: `implement` spawns an isolated child, which pauses at its gate;
    // the parent pauses blocked on it. `review` has not been reached.
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
    expect(r1.success && 'paused' in r1 && r1.paused).toBe(true);
    expect(calls.map(c => c.nodeId)).toEqual(['implement']);

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-gated-iso');
    const gatedChild = [...store.runs.values()].find(r => r.workflow_name === 'child-gated-iso');
    expect(parentRun?.status).toBe('paused');
    expect(gatedChild?.status).toBe('paused');
    expect(gatedChild?.working_path).not.toBe(cwd);

    // Approve the child and resume it in its OWN worktree, the way the CLI does —
    // with a resolver injected, since the surface builds one per dispatch. The
    // child's completion fires the parent auto-resume hook in-process.
    store.approveGate(gatedChild!.id);
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(gatedChild!.id))!);
    expect(hydrated).not.toBeNull();
    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      gatedChild!.working_path!,
      await discover('child-gated-iso'),
      gatedChild!.user_message,
      'conv-db',
      { ...hydrated!, resolveChildIsolation: resolver }
    );

    // The parent resumed and reached `review`, which got its OWN worktree.
    expect(calls.map(c => c.nodeId)).toEqual(['implement', 'review']);
    const reviewFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'review'
    );
    expect(reviewFailed).toBeUndefined();

    const finalParent = await store.getWorkflowRun(parentRun!.id);
    expect(finalParent?.status).toBe('completed');
    expect((await store.getWorkflowRun(gatedChild!.id))?.status).toBe('completed');

    // Distinct things, distinct checkouts: two isolated nodes → two worktrees, and
    // neither is the parent's.
    const reviewChild = [...store.runs.values()].find(r => r.workflow_name === 'child-review-iso');
    expect(reviewChild?.status).toBe('completed');
    expect(reviewChild?.working_path).not.toBe(cwd);
    expect(reviewChild?.working_path).not.toBe(gatedChild?.working_path);
  });

  // --- slice 2, PR-C: dynamic fan-out -------------------------------------------

  /** Child that echoes its per-item $ARGUMENTS, so fan-out aggregate ordering + the
   *  item→$ARGUMENTS channel are both observable. Declares no `mutates_checkout`, so it
   *  is treated as a repo-writing child (the default posture). */
  const fanChildEcho = `
name: fan-child
description: echoes its per-item argument
nodes:
  - id: echo
    bash: |
      printf 'did:%s' "$ARGUMENTS"
`;

  /** The same child, declared read-only — the supported way for N concurrent children to
   *  share the parent's checkout (`mutates_checkout: false` skips the path lock). */
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
      'conv-db',
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-parent');
    expect(parentRun?.status).toBe('completed');

    // `isolation: worktree` on the fan-out node isolates every child: the resolver was
    // called once per item, with distinct child indexes.
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
      'conv-db',
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

  it('blocks a shared-checkout fan-out over a repo-writing child BEFORE any child is spawned', async () => {
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

    const store = new InMemoryStore();
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
      'conv-db',
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(false);
    // Nothing was spawned and nothing was isolated — the cost of finding out at runtime
    // (N-1 self-cancelled siblings, unrecoverable by resume) is never paid.
    expect([...store.runs.values()].filter(r => r.workflow_name === 'fan-child')).toHaveLength(0);
    expect(calls).toHaveLength(0);

    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    const error = String(nodeFailed?.data?.error);
    // The message names all three ways out — the author picks, the engine never guesses.
    expect(error).toContain('mutates_checkout: false');
    expect(error).toContain('isolation: worktree');
    expect(error).toContain('max_parallel: 1');
    expect(error).toContain('fan-child');
  });

  it('an orphan-cancelled index is re-driven on resume, not left permanently cancelled', async () => {
    // `fan_out_orphan` is stamped by the ENGINE when the item list shrinks under a child.
    // If it is not in the recoverable set it reads as a user cancel: items shrinking and
    // then growing back leaves those slots dead under all_done, and fails the node on every
    // resume under all_success with no way back.
    await writeWorkflow('fan-child', fanChildEcho);
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
      conversation_id: 'conv-db',
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
      conversation_id: 'conv-db',
      user_message: 'b',
      parent_run_id: parentRun.id,
      working_path: cwd,
      metadata: { parent_node_id: 'work', child_index: 1, cancelled_reason: 'fan_out_orphan' },
    });
    await store.updateWorkflowRun(orphan.id, { status: 'cancelled' });

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      {
        ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }),
        resolveChildIsolation: resolver,
      }
    );

    // The orphan was re-driven in place and the node completed.
    expect(r.success).toBe(true);
    expect((await store.getWorkflowRun(orphan.id))?.status).toBe('completed');
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
      conversation_id: 'conv-db',
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
      conversation_id: 'conv-db',
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
      'conv-db',
      { ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }) }
    );

    // Index 0 ran and the node completed; the untracked leftover was cancelled, not left
    // running forever.
    expect(r.success).toBe(true);
    const after = await store.getWorkflowRun(legacy.id);
    expect(after?.status).toBe('cancelled');
    expect((after?.metadata as Record<string, unknown>).cancelled_reason).toBe('fan_out_orphan');
  });

  it('a resume with ONE instance left is not blocked by the shared-checkout preflight', async () => {
    // The preflight counts the indices this attempt will actually DRIVE, not items.length.
    // Counting items.length instead would block every resume of a wide shared-checkout
    // fan-out — including one with a single failed instance left, where there is no
    // concurrency at all. That inversion (blocking recovery from an unrelated failure) is
    // the bug this branch already fixed once, and nothing pinned it until now.
    await writeWorkflow('fan-child', fanChildEcho);
    await writeWorkflow(
      'fan-resume-preflight',
      `
name: fan-resume-preflight
description: wide fan-out over a repo-writing child, resumed with one instance left
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b","c"]'
  - id: work
    workflow: fan-child
    depends_on: [plan]
    fan_out:
      items: "$plan.output"
      max_parallel: 3
      join: all_success
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-resume-preflight');

    // Seed a partly-completed attempt: indices 0 and 2 completed, index 1 failed. The child
    // declares no `mutates_checkout: false`, so a preflight counting items.length would see
    // 3 and refuse; counting drivable indices sees 1 and proceeds.
    const parentRun = await store.createWorkflowRun({
      workflow_name: 'fan-resume-preflight',
      conversation_id: 'conv-db',
      user_message: 'goal',
      working_path: cwd,
    });
    store.events.push({
      workflow_run_id: parentRun.id,
      event_type: 'node_completed',
      step_name: 'plan',
      data: { node_output: '["a","b","c"]' },
    });
    const seed = async (idx: number, status: WorkflowRun['status']): Promise<void> => {
      const child = await store.createWorkflowRun({
        workflow_name: 'fan-child',
        conversation_id: 'conv-db',
        user_message: ['a', 'b', 'c'][idx],
        parent_run_id: parentRun.id,
        working_path: cwd,
        metadata: { parent_node_id: 'work', child_index: idx },
      });
      await store.updateWorkflowRun(child.id, { status });
      if (status === 'completed') {
        await store.updateWorkflowRun(child.id, {
          metadata: { summary: `did:${['a', 'b', 'c'][idx]}` },
        });
      }
    };
    await seed(0, 'completed');
    await seed(1, 'failed');
    await seed(2, 'completed');

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { ...(hydrated ?? { preCreatedRun: await store.resumeWorkflowRun(parentRun.id) }) }
    );

    // The resume completed: the one failed instance was re-driven, and the preflight did
    // not fire on a `max_parallel: 3` node whose remaining work is a single child.
    expect(r.success).toBe(true);
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    expect(String(nodeFailed?.data?.error ?? '')).not.toContain('mutates_checkout');
    expect([...store.runs.values()].filter(c => c.workflow_name === 'fan-child')).toHaveLength(3);
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
      printf '%s' '["alpha","beta","gamma"]'
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
      'conv-db',
      { resolveChildIsolation: resolver }
    );

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(0);
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child');
    expect(children).toHaveLength(3);
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

  /** Child that succeeds echoing its arg, but fails (exit 3) on the item "boom". Read-only,
   *  so N of these share the parent checkout without contending for the path lock. */
  const fanChildCond = `
name: fan-child-cond
description: fails on the item "boom", echoes otherwise
mutates_checkout: false
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "boom" ]; then exit 3; fi
      printf 'ok:%s' "$ARGUMENTS"
`;

  it('the DEFAULT join succeeds with a failed child, aggregating all three outcomes', async () => {
    // Independence: children are separate jobs, so one failing must not discard the other
    // two. The default has to carry that — an author who writes no `join:` gets it.
    await writeWorkflow('fan-child-cond', fanChildCond);
    await writeWorkflow(
      'fan-default-join',
      `
name: fan-default-join
description: no join declared — takes the default
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
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-default-join');
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    // The node — and the run — SUCCEED despite the middle child failing.
    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-default-join');
    expect(parentRun?.status).toBe('completed');

    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-cond');
    expect(children).toHaveLength(3);

    // All three outcomes reach the aggregate, in item order, with the failure as DATA in
    // its own slot rather than as an absence.
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    const aggregate = JSON.parse(String(workCompleted?.data?.node_output)) as unknown[];
    expect(aggregate).toHaveLength(3);
    expect(aggregate[0]).toBe('ok:a');
    expect(aggregate[2]).toBe('ok:c');
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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
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
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-cost');
    // 3 children × 0.01 each = 0.03 rolled up to the parent (plan is bash → 0 cost).
    expect((parentRun?.metadata as Record<string, unknown>).total_cost_usd).toBeCloseTo(0.03, 5);

    // Tokens must be PERSISTED on the node_completed event, not merely computed. This is
    // the axis getDagResumeSnapshot sums to rebuild usage across resume passes — it never
    // reads cost_usd — so dropping it here under-reports every resumed run by exactly the
    // children's tokens, silently, and on Codex (which reports no cost) loses everything.
    const workCompleted = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'work'
    );
    expect(workCompleted?.data?.cost_usd).toBeCloseTo(0.03, 5);
    expect(workCompleted?.data?.tokens).toBeDefined();
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
    // cancels a sibling, so run 1 always ends index 0 and 2 completed and index 1 failed.
    // (This test used to be pinned to max_parallel: 1 purely to dodge that race.)
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

    // First drive: the flaky child (index 1) fails; indexes 0 and 2 run to completion
    // regardless, and the node fails afterwards under all_success.
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
      'conv-db',
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    expect(r2.success).toBe(true);
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('completed');
    // Exactly 3 child rows — one per index; the failed one was re-driven in its own row.
    expect(
      [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-flaky')
    ).toHaveLength(3);
    // The completed child was threaded from its row, not re-executed. Row count can't show
    // this (a re-drive reuses the row) but completed_at can — re-driving it would stamp a
    // new one, even though its own DAG node would be skipped by the child's resume.
    expect((await store.getWorkflowRun(byIndex1.get(0)!.id))?.completed_at).toEqual(
      completedAtBefore
    );
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
mutates_checkout: false
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
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-gated-parent');
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
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-gated-parent');
    expect(parentRun?.status).toBe('failed');
    // The parent must NOT be paused blocked-on-child — a fan-out node never holds the
    // single gate slot (#2180); it fails instead.
    expect((parentRun?.metadata as Record<string, unknown>).approval).toBeUndefined();

    // Every fan-out child that paused was cancelled — tagged `fan_out_gate` so removing
    // the gate + resuming re-drives it (C2), not a bare cancel.
    const children = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-gated');
    expect(children.length).toBeGreaterThanOrEqual(1);
    for (const c of children) {
      expect(c.status).toBe('cancelled');
      expect((c.metadata as Record<string, unknown>).cancelled_reason).toBe('fan_out_gate');
    }
    const nodeFailed = store.events.find(
      e => e.event_type === 'node_failed' && e.step_name === 'work'
    );
    // Enriched message (I4): names the offending child index + run id.
    expect(String(nodeFailed?.data?.error)).toContain('autonomously');
    expect(String(nodeFailed?.data?.error)).toContain('#2180');
    expect(String(nodeFailed?.data?.error)).toMatch(/child \d+ \(run [\w-]+\)/);
  });

  it('a running fan-out child found on resume fails the node WITHOUT cancelling it (C1)', async () => {
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
      conversation_id: 'conv-db',
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
      conversation_id: 'conv-db',
      user_message: 'x',
      parent_run_id: parentRun.id,
      working_path: cwd,
      metadata: { parent_node_id: 'work', child_index: 0 },
    });
    await store.updateWorkflowRun(child.id, { status: 'running' });

    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun.id))!);
    const r = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db',
      { ...hydrated! }
    );

    expect(r.success).toBe(false);
    // The ambiguous running child is NOT autonomously cancelled (CLAUDE.md lifecycle rule).
    expect((await store.getWorkflowRun(child.id))?.status).toBe('running');
    const nodeFailed = [...store.events]
      .reverse()
      .find(e => e.event_type === 'node_failed' && e.step_name === 'work');
    expect(String(nodeFailed?.data?.error)).toContain('may still be running');
    expect(String(nodeFailed?.data?.error)).not.toContain('gate');
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
      conversation_id: 'conv-db',
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
      conversation_id: 'conv-db',
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
      'conv-db',
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

  it('a fan-out-cancelled gate child is re-driven on resume once the gate is removed (C2)', async () => {
    const gatedChild = `
name: fan-child-recover
description: has an approval gate on the first pass
interactive: true
nodes:
  - id: impl
    prompt: "implement $ARGUMENTS"
  - id: gate
    approval:
      message: "review"
    depends_on: [impl]
`;
    const ungatedChild = `
name: fan-child-recover
description: gate removed
nodes:
  - id: impl
    prompt: "implement $ARGUMENTS"
`;
    await writeWorkflow('fan-child-recover', gatedChild);
    await writeWorkflow(
      'fan-c2-recover',
      `
name: fan-c2-recover
description: gate-cancelled children recover on resume (inherit, serial)
interactive: true
nodes:
  - id: plan
    bash: |
      printf '%s' '["a","b"]'
  - id: work
    workflow: fan-child-recover
    depends_on: [plan]
    isolation: inherit
    fan_out:
      items: "$plan.output"
      max_parallel: 1
`
    );

    const store = new InMemoryStore();
    const deps = makeDeps(store);
    const parent = await discover('fan-c2-recover');

    // Run 1: the first child pauses at its gate → node fails, that child cancelled (tagged).
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
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'fan-c2-recover');
    const child0 = [...store.runs.values()].find(
      r =>
        r.workflow_name === 'fan-child-recover' &&
        (r.metadata as Record<string, unknown>).child_index === 0
    );
    expect(child0?.status).toBe('cancelled');
    expect((child0?.metadata as Record<string, unknown>).cancelled_reason).toBe('fan_out_gate');

    // Author removes the gate, then resumes the parent.
    await writeWorkflow('fan-child-recover', ungatedChild);
    const parent2 = await discover('fan-c2-recover');
    const hydrated = await hydrateResumableRun(deps, (await store.getWorkflowRun(parentRun!.id))!);
    const resumeOpts = hydrated ?? {
      preCreatedRun: await store.resumeWorkflowRun(parentRun!.id),
    };
    const r2 = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent2,
      'goal',
      'conv-db',
      { ...resumeOpts }
    );

    expect(r2.success).toBe(true);
    expect((await store.getWorkflowRun(parentRun!.id))?.status).toBe('completed');
    // The gate-cancelled child was re-driven IN PLACE (same row) → completed; index 1 ran too.
    expect((await store.getWorkflowRun(child0!.id))?.status).toBe('completed');
    const recovered = [...store.runs.values()].filter(r => r.workflow_name === 'fan-child-recover');
    expect(recovered).toHaveLength(2);
    expect(recovered.every(r => r.status === 'completed')).toBe(true);
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
      'conv-db',
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
    await store.cancelWorkflowRun(childA!.id);
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
      'conv-db',
      { ...resumeOpts, resolveChildIsolation: resolver }
    );

    // The untagged user-cancel is terminal → node still fails; child A is NOT resurrected.
    expect(r2.success).toBe(false);
    const childAafter = await store.getWorkflowRun(childA!.id);
    expect(childAafter?.status).toBe('cancelled');
    expect((childAafter?.metadata as Record<string, unknown>).cancelled_reason).toBeUndefined();
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
    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

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

// ===========================================================================
// LATE-RESOLUTION AFFORDANCE + RUNTIME-AUTHORED SUB-RUNS
// ---------------------------------------------------------------------------
// These lock a property that looks like an inconsistency and is not:
//
//   `include:` resolves its target at LOAD time (include-expander, at discovery).
//   `workflow:` resolves its target at SPAWN time (runChildWorkflow → discover).
//
// A tidy-up PR that "fixes" the asymmetry by adding a load-time existence check
// to `workflow:` would compile, pass every other test in this file, and silently
// destroy the only mechanism by which a run can author and execute its own
// children. That mechanism is the substrate for agent-authored ("god mode")
// workflows: the agent's decisions land as real YAML, run as real governed child
// runs, and stay promotable into the deterministic lane.
//
// Late resolution is therefore a DELIBERATE CONSTITUTIONAL AFFORDANCE, not an
// oversight. If you are here because one of these tests failed, the question to
// answer before changing them is: "does agent-authored sub-run composition still
// work?" — not "should validation be stricter?".
//
// See: packages/docs-web/src/content/docs/reference/workflow-language-constitution.md
// ===========================================================================
describe('workflow: late resolution is a deliberate affordance', () => {
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

  /** A child workflow whose single bash node echoes a caller-supplied marker. */
  function slotYaml(name: string, marker: string): string {
    return `
name: ${name}
description: runtime-authored slot
nodes:
  - id: emit
    bash: echo "${marker} input=$ARGUMENTS"
`;
  }

  beforeEach(async () => {
    cwd = join(tmpdir(), `lateres-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(cwd, '.archon', 'workflows'), { recursive: true });
    process.env.ARCHON_HOME = join(cwd, 'home');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  // --- Group 1: load-time must stay permissive -----------------------------

  it('LOCK: discovery ACCEPTS a workflow: node whose target does not exist', async () => {
    // If this ever fails, someone added a load-time existence check. That check
    // makes runtime-authored children impossible — the slot does not exist yet
    // when the parent is loaded, by construction.
    await writeWorkflow(
      'parent-forward-ref',
      `
name: parent-forward-ref
description: references a slot that will only exist at spawn time
nodes:
  - id: sub
    workflow: not-yet-authored
`
    );

    const result = await discoverWorkflows(cwd, { loadDefaults: false });
    expect(result.errors).toHaveLength(0);
    expect(result.workflows.map(w => w.workflow.name)).toContain('parent-forward-ref');
  });

  it('LOCK: validateWorkflowResources does NOT flag an unresolvable sub-run target', async () => {
    // `archon validate workflows` goes through this. It must stay quiet about
    // sub-run targets — a forward reference is legal by design. (Contrast
    // `include:`, whose target IS resolved at load and DOES error when missing.)
    await writeWorkflow(
      'parent-forward-ref',
      `
name: parent-forward-ref
description: references a slot that will only exist at spawn time
nodes:
  - id: sub
    workflow: not-yet-authored
`
    );

    const wf = await discover('parent-forward-ref');
    const issues = await validateWorkflowResources(wf, cwd);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  // --- Group 2: the generate-and-run mechanism -----------------------------

  it('a run authors a child mid-flight and a later workflow: node executes it', async () => {
    // The core god-mode primitive. `author` writes the slot; `sub` resolves it at
    // spawn time. Neither the slot file nor its name existed when the parent was
    // loaded.
    await writeWorkflow(
      'parent-authors-child',
      `
name: parent-authors-child
description: authors its own child, then runs it
nodes:
  - id: author
    bash: |
      cat > "${join(cwd, '.archon', 'workflows')}/authored-slot.yaml" <<'YAML'
      name: authored-slot
      description: written at runtime
      nodes:
        - id: emit
          bash: echo "AUTHORED_AT_RUNTIME input=$ARGUMENTS"
      YAML
      echo wrote
  - id: sub
    workflow: authored-slot
    input: from-parent
    depends_on: [author]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-authors-child');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    expect(result.success).toBe(true);

    const parentRun = [...store.runs.values()].find(
      r => r.workflow_name === 'parent-authors-child'
    );
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.workflow_name).toBe('authored-slot');
    expect(children[0]?.status).toBe('completed');
    // The child received the parent's `input` as its user message...
    expect(children[0]?.user_message).toBe('from-parent');
    // ...and its output threaded back through the node.
    const done = store.events.find(e => e.event_type === 'node_completed' && e.step_name === 'sub');
    expect(String(done?.data?.node_output)).toContain('AUTHORED_AT_RUNTIME');
    expect(String(done?.data?.node_output)).toContain('from-parent');
  });

  it('LOCK: sub-run discovery is NOT cached across spawns in one run', async () => {
    // Caching discovery would be a defensible performance change and would break
    // re-authoring: the second spawn would replay the first body. Two sibling
    // nodes target the SAME name with the slot rewritten in between.
    await writeWorkflow('reused-slot', slotYaml('reused-slot', 'VERSION_ONE'));
    await writeWorkflow(
      'parent-reauthors',
      `
name: parent-reauthors
description: re-authors one slot between two sibling sub-runs
nodes:
  - id: pass-one
    workflow: reused-slot
    input: first
  - id: rewrite
    bash: |
      cat > "${join(cwd, '.archon', 'workflows')}/reused-slot.yaml" <<'YAML'
      name: reused-slot
      description: rewritten
      nodes:
        - id: emit
          bash: echo "VERSION_TWO input=$ARGUMENTS"
      YAML
      echo rewrote
    depends_on: [pass-one]
  - id: pass-two
    workflow: reused-slot
    input: second
    depends_on: [rewrite]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-reauthors');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    expect(result.success).toBe(true);

    const one = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'pass-one'
    );
    const two = store.events.find(
      e => e.event_type === 'node_completed' && e.step_name === 'pass-two'
    );
    expect(String(one?.data?.node_output)).toContain('VERSION_ONE');
    expect(String(two?.data?.node_output)).toContain('VERSION_TWO');
  });

  // --- Group 3: iteration by unrolling -------------------------------------

  it('LOCK: repeated SIBLING sub-runs of one name are not a cycle (unrolled iteration)', async () => {
    // The cycle guard walks ANCESTRY. Two sequential children of the same parent
    // are siblings, not ancestors — so a driver can run the same slot N times.
    // Tightening the guard to "name seen anywhere in the run tree" would make
    // unrolled iteration impossible. Complements the ancestry-cycle tests above,
    // which must keep passing.
    await writeWorkflow('loop-slot', slotYaml('loop-slot', 'PASS'));
    await writeWorkflow(
      'parent-unrolled',
      `
name: parent-unrolled
description: three sequential sub-runs of the same slot
nodes:
  - id: p1
    workflow: loop-slot
    input: one
  - id: p2
    workflow: loop-slot
    input: two
    depends_on: [p1]
  - id: p3
    workflow: loop-slot
    input: three
    depends_on: [p2]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-unrolled');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-unrolled');
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    expect(children).toHaveLength(3);
    expect(children.every(c => c.status === 'completed')).toBe(true);
    // Each pass got its own input — they are distinct runs, not a replayed one.
    expect(children.map(c => c.user_message).sort()).toEqual(['one', 'three', 'two']);
  });

  it('when: on a later pass short-circuits the unrolled loop (early termination)', async () => {
    // Early exit is what makes an unrolled loop a LOOP rather than a fixed chain:
    // a bash node decides, and `when:` skips the remaining passes.
    await writeWorkflow('exit-slot', slotYaml('exit-slot', 'RAN'));
    await writeWorkflow(
      'parent-earlyexit',
      `
name: parent-earlyexit
description: stops after pass one when the check says DONE
nodes:
  - id: p1
    workflow: exit-slot
    input: one
  - id: check
    bash: echo DONE
    depends_on: [p1]
  - id: p2
    workflow: exit-slot
    input: two
    when: "$check.output != 'DONE'"
    depends_on: [check]
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-earlyexit');
    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    expect(result.success).toBe(true);
    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-earlyexit');
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    // Exactly one child: the skipped pass must not spawn a run.
    expect(children).toHaveLength(1);
    expect(children[0]?.user_message).toBe('one');
  });

  // --- Group 4: known gaps, characterized so a fix fails loudly ------------

  it('GAP (#2200): a runtime-authored slot leaks into project-wide discovery', async () => {
    // A workflow authored for ONE run lands in the repo-scoped source tree, so it
    // becomes globally visible: `workflow list` shows it and the chat router can
    // match it. It is also NOT gitignored, so it is stageable into the user's repo
    // — the exact output-in-repo class #2200 exists to eliminate.
    //
    // The fix is a run-scoped fourth discovery tier (bundled < home < repo < run),
    // visible only to the spawning run's sub-run resolution. When that lands, this
    // assertion must flip to expect the slot to be ABSENT from plain discovery.
    await writeWorkflow('leaky-slot', slotYaml('leaky-slot', 'LEAK'));

    const result = await discoverWorkflows(cwd, { loadDefaults: false });
    expect(result.workflows.map(w => w.workflow.name)).toContain('leaky-slot');
  });

  it('GAP: concurrent fan-out cancels a sibling unless the child sets mutates_checkout:false', async () => {
    // The path lock (executor.ts, "Siblings are intentionally NOT excluded") means two
    // `workflow:` nodes in one layer collide on the shared checkout: the loser
    // self-cancels and its parent node fails. This is NOT the gate-slot bug — it
    // happens with no gates anywhere, and it makes the default fan-out layout
    // (`plan → [worker-a, worker-b]`) fail deterministically.
    //
    // The escape hatch is `mutates_checkout: false` on the CHILD workflow: the author
    // asserts the child does not write the checkout, and the lock is skipped.
    //
    // Consequence for fan-out designs: analysis/review peers that write only to
    // $ARTIFACTS_DIR can run concurrently TODAY. Peers that EDIT the repo cannot —
    // those need per-child isolation (`isolation: worktree`, reserved + rejected in
    // slice 1). Both halves are asserted so a change to either is visible.
    const childYaml = (name: string, extra: string): string => `
name: ${name}
description: fan-out child
${extra}nodes:
  - id: emit
    bash: echo ok
`;
    const parentYaml = (child: string): string => `
name: parent-fanout-${child}
description: two ${child} children in one layer
nodes:
  - id: a
    workflow: ${child}
    input: a
  - id: b
    workflow: ${child}
    input: b
`;
    await writeWorkflow('racy-child', childYaml('racy-child', ''));
    await writeWorkflow('safe-child', childYaml('safe-child', 'mutates_checkout: false\n'));
    await writeWorkflow('parent-fanout-racy-child', parentYaml('racy-child'));
    await writeWorkflow('parent-fanout-safe-child', parentYaml('safe-child'));

    const kids = (store: InMemoryStore, name: string): string[] => {
      const parentRun = [...store.runs.values()].find(r => r.workflow_name === name);
      return [...store.runs.values()]
        .filter(r => r.parent_run_id === parentRun?.id)
        .map(r => r.status)
        .sort();
    };

    // Default posture: the sibling is cancelled and the parent run fails.
    const racyStore = new InMemoryStore();
    const racyResult = await executeWorkflow(
      makeDeps(racyStore),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-fanout-racy-child'),
      'goal',
      'conv-db'
    );
    expect(racyResult.success).toBe(false);
    expect(kids(racyStore, 'parent-fanout-racy-child')).toEqual(['cancelled', 'completed']);

    // With mutates_checkout:false the lock is skipped and both children run.
    const safeStore = new InMemoryStore();
    const safeResult = await executeWorkflow(
      makeDeps(safeStore),
      makePlatform(),
      'conv-plat',
      cwd,
      await discover('parent-fanout-safe-child'),
      'goal',
      'conv-db'
    );
    expect(safeResult.success).toBe(true);
    expect(kids(safeStore, 'parent-fanout-safe-child')).toEqual(['completed', 'completed']);
  });

  it('GAP (#2180 Defect A): a GATING child loses the path lock before it ever reaches its gate', async () => {
    // Fan-out where both children would gate. What actually happens is the PATH LOCK
    // (Defect A), not the gate-slot collision: the losing child is cancelled before it
    // ever reaches its `approval:` node, so `pauseParentOnChild` never runs for it.
    //
    // SCOPE LIMIT — READ BEFORE TRUSTING THIS TEST FOR #2180 Defect B.
    // This test CANNOT characterize the single-gate-slot collision. `InMemoryStore`'s
    // `pauseWorkflowRun` (see above) is an unconditional status write; production's is
    // `UPDATE … WHERE status='running'` that THROWS on a 0-row match
    // (`packages/core/src/db/workflows.ts:942+`). Without that CAS there is no second
    // pauser to lose. A faithful Defect-B test needs a store double that mirrors the
    // compare-and-set.
    //
    // Note also that the two pause call sites behave DIFFERENTLY on collision, so a
    // Defect-B test must pick one deliberately:
    //   • `approval:` / interactive `loop:` gates → `pauseGateRespectingExternalTransition`
    //     catches the throw, re-reads status, sees 'paused', and returns SUCCESS (the
    //     collision is misclassified as a legitimate external transition, #1123).
    //   • `pauseParentOnChild` (workflow: nodes) → bypasses that wrapper, so the throw
    //     reaches the generic per-node catch and DOES emit node_failed.
    await writeWorkflow(
      'gating-child',
      `
name: gating-child
description: pauses at a gate
nodes:
  - id: gate
    approval:
      message: needs review
`
    );
    await writeWorkflow(
      'parent-fanout-gates',
      `
name: parent-fanout-gates
description: two gating children in the same layer
nodes:
  - id: a
    workflow: gating-child
    input: a
  - id: b
    workflow: gating-child
    input: b
`
    );

    const store = new InMemoryStore();
    const parent = await discover('parent-fanout-gates');
    await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-plat',
      cwd,
      parent,
      'goal',
      'conv-db'
    );

    const parentRun = [...store.runs.values()].find(r => r.workflow_name === 'parent-fanout-gates');
    const children = [...store.runs.values()].filter(r => r.parent_run_id === parentRun?.id);
    // Both children are created, but only ONE survives. The issue body described the
    // loser as "real but unmentioned"; in fact it loses the PATH LOCK and is CANCELLED
    // before reaching its gate — and because the cancellation surfaces through
    // `pauseParentOnChild`'s node, a node_failed IS emitted. That event is Defect A's
    // ("was cancelled"), NOT evidence about the gate slot.
    expect(children).toHaveLength(2);
    expect(children.map(c => c.status).sort()).toEqual(['cancelled', 'paused']);
    const loserFailed = store.events.find(
      e => e.event_type === 'node_failed' && String(e.data?.error).includes('was cancelled')
    );
    expect(loserFailed).toBeDefined();
    // The parent records exactly one block reason — the surviving paused child.
    const approval = (parentRun?.metadata as Record<string, unknown> | undefined)?.approval as
      | Record<string, unknown>
      | undefined;
    expect(approval).toBeDefined();
    const paused = children.find(c => c.status === 'paused');
    expect(String(approval?.childRunId ?? '')).toBe(paused?.id ?? '');
  });
});
