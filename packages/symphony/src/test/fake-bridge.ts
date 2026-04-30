/**
 * In-memory fakes for the workflow bridge — used by orchestrator tests so we
 * don't have to boot the real Archon executor (which loads provider SDKs and
 * resolves git worktrees).
 *
 * The fakes mirror the shape of `BridgeDeps` from `../workflow-bridge/types`
 * but skip the side-effects: `runWorkflow` records its calls and lets tests
 * synthesize `workflow_completed | workflow_failed | workflow_cancelled`
 * events through `controls.emit(...)`.
 */
import type { IDatabase } from '@archon/core/db';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowDeps } from '@archon/workflows/deps';
import type {
  WorkflowDefinition,
  WorkflowExecutionResult,
} from '@archon/workflows/schemas/workflow';
import type {
  ApprovalContext,
  WorkflowRun,
  WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import type {
  BridgeCodebase,
  BridgeConversation,
  BridgeDeps,
  BridgeWebAdapter,
  RunWorkflowFn,
  RunWorkflowInput,
} from '../workflow-bridge/types';

interface InMemoryRun {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  status: WorkflowRunStatus;
  metadata: Record<string, unknown>;
  user_message: string;
  parent_conversation_id: string | null;
  working_path: string | null;
  started_at: Date;
  completed_at: Date | null;
  last_activity_at: Date | null;
}

function toWorkflowRun(r: InMemoryRun): WorkflowRun {
  return {
    id: r.id,
    workflow_name: r.workflow_name,
    conversation_id: r.conversation_id,
    parent_conversation_id: r.parent_conversation_id,
    codebase_id: r.codebase_id,
    status: r.status,
    user_message: r.user_message,
    metadata: r.metadata,
    started_at: r.started_at,
    completed_at: r.completed_at,
    last_activity_at: r.last_activity_at,
    working_path: r.working_path,
  };
}

export interface FakeStore extends IWorkflowStore {
  /** Direct map access for tests asserting against pre-created rows. */
  readonly runs: Map<string, InMemoryRun>;
  /** Override the result of `getWorkflowRunStatus(id)` for reconcile tests. */
  setStatus(id: string, status: WorkflowRunStatus): void;
}

export function makeFakeStore(opts: { db?: IDatabase } = {}): FakeStore {
  const runs = new Map<string, InMemoryRun>();
  let runCounter = 0;
  const db = opts.db;
  const store: FakeStore = {
    runs,
    setStatus(id, status) {
      const run = runs.get(id);
      if (!run) throw new Error(`fake store: unknown run id ${id}`);
      run.status = status;
    },
    async createWorkflowRun(data) {
      runCounter += 1;
      const id = `wfr-fake-${String(runCounter)}`;
      const created: InMemoryRun = {
        id,
        workflow_name: data.workflow_name,
        conversation_id: data.conversation_id,
        codebase_id: data.codebase_id ?? null,
        status: 'pending',
        metadata: data.metadata ?? {},
        user_message: data.user_message,
        parent_conversation_id: data.parent_conversation_id ?? null,
        working_path: data.working_path ?? null,
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
      };
      runs.set(id, created);
      // When a DB handle is provided, also write a row that satisfies
      // symphony_dispatches.workflow_run_id FK constraints. Tests that don't
      // need FK enforcement skip the db parameter.
      if (db) {
        await db.query(
          `INSERT INTO remote_agent_workflow_runs
             (id, conversation_id, workflow_name, user_message, status, metadata, codebase_id, parent_conversation_id, working_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            data.conversation_id,
            data.workflow_name,
            data.user_message,
            'pending',
            JSON.stringify(data.metadata ?? {}),
            data.codebase_id ?? null,
            data.parent_conversation_id ?? null,
            data.working_path ?? null,
          ]
        );
      }
      return toWorkflowRun(created);
    },
    async getWorkflowRun(id) {
      const r = runs.get(id);
      return r ? toWorkflowRun(r) : null;
    },
    async getActiveWorkflowRunByPath() {
      return null;
    },
    async findResumableRun() {
      return null;
    },
    async failOrphanedRuns() {
      return { count: 0 };
    },
    async resumeWorkflowRun(id) {
      const r = runs.get(id);
      if (!r) throw new Error(`fake store: unknown run id ${id}`);
      r.status = 'running';
      return toWorkflowRun(r);
    },
    async updateWorkflowRun(id, updates) {
      const r = runs.get(id);
      if (!r) return;
      if (updates.status !== undefined) r.status = updates.status;
      if (updates.metadata !== undefined) r.metadata = updates.metadata;
    },
    async updateWorkflowActivity(id) {
      const r = runs.get(id);
      if (r) r.last_activity_at = new Date();
    },
    async getWorkflowRunStatus(id) {
      return runs.get(id)?.status ?? null;
    },
    async completeWorkflowRun(id, metadata) {
      const r = runs.get(id);
      if (!r) return;
      r.status = 'completed';
      r.completed_at = new Date();
      if (metadata) r.metadata = metadata;
      if (db) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          'completed',
          id,
        ]);
      }
    },
    async failWorkflowRun(id, error) {
      const r = runs.get(id);
      if (!r) return;
      r.status = 'failed';
      r.completed_at = new Date();
      r.metadata = { ...r.metadata, error };
      if (db) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          'failed',
          id,
        ]);
      }
    },
    async pauseWorkflowRun(id, approvalContext: ApprovalContext) {
      const r = runs.get(id);
      if (!r) return;
      r.status = 'paused';
      r.metadata = { ...r.metadata, approval: approvalContext };
    },
    async cancelWorkflowRun(id) {
      const r = runs.get(id);
      if (!r) return;
      r.status = 'cancelled';
      r.completed_at = new Date();
      if (db) {
        await db.query('UPDATE remote_agent_workflow_runs SET status = $1 WHERE id = $2', [
          'cancelled',
          id,
        ]);
      }
    },
    async createWorkflowEvent() {
      // no-op
    },
    async getCompletedDagNodeOutputs() {
      return new Map();
    },
    async getCodebase() {
      return null;
    },
    async getCodebaseEnvVars() {
      return {};
    },
  };
  return store;
}

export interface FakeWebAdapter extends BridgeWebAdapter {
  /** Map populated by setConversationDbId calls. */
  readonly dbIds: Map<string, string>;
}

export function makeFakeWebAdapter(): FakeWebAdapter {
  const dbIds = new Map<string, string>();
  return {
    dbIds,
    setConversationDbId(platformId, dbId) {
      dbIds.set(platformId, dbId);
    },
    async sendMessage() {
      // no-op
    },
    getStreamingMode() {
      return 'batch';
    },
    getPlatformType() {
      return 'web';
    },
  };
}

export interface FakeEmitter {
  subscribe(listener: (event: WorkflowEmitterEvent) => void): () => void;
  emit(event: WorkflowEmitterEvent): void;
  /** Active listener count (tests assert on subscription lifecycle). */
  listenerCount(): number;
}

export function makeFakeEmitter(): FakeEmitter {
  const listeners = new Set<(event: WorkflowEmitterEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const l of listeners) l(event);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

export interface RecordedRunWorkflowCall {
  input: RunWorkflowInput;
}

export interface FakeBridge {
  bridge: BridgeDeps;
  store: FakeStore;
  platform: FakeWebAdapter;
  emitter: FakeEmitter;
  /** All `runWorkflow` invocations in order. */
  readonly runs: RecordedRunWorkflowCall[];
  /** Fake codebase rows; keyed by codebase id. Tests preload these. */
  readonly codebases: Map<string, BridgeCodebase>;
  /** Conversation ids the dispatcher created. */
  readonly conversations: BridgeConversation[];
  /** Override `runWorkflow` to throw or return a different result. */
  setRunWorkflow(fn: RunWorkflowFn): void;
  /** Override the workflow resolver. */
  setResolveWorkflow(fn: (name: string, cwd: string) => Promise<WorkflowDefinition | null>): void;
}

export function makeFakeBridge(
  opts: {
    workflows?: Record<string, WorkflowDefinition>;
    codebases?: Map<string, BridgeCodebase>;
    /**
     * When provided, the bridge writes real `remote_agent_conversations` and
     * `remote_agent_workflow_runs` rows so the `symphony_dispatches` FK
     * constraints are satisfied. Pure-unit tests can omit this.
     */
    db?: IDatabase;
  } = {}
): FakeBridge {
  const store = makeFakeStore({ db: opts.db });
  const platform = makeFakeWebAdapter();
  const emitter = makeFakeEmitter();
  const codebases = opts.codebases ?? new Map<string, BridgeCodebase>();
  const conversations: BridgeConversation[] = [];
  const runs: RecordedRunWorkflowCall[] = [];
  let convCounter = 0;

  let runWorkflowFn: RunWorkflowFn = async () => {
    // default: no-op fire-and-forget
  };
  let resolveWorkflow: (
    name: string,
    cwd: string
  ) => Promise<WorkflowDefinition | null> = async name => {
    const wf = opts.workflows?.[name];
    return wf ?? null;
  };

  const workflowDeps: WorkflowDeps = {
    store,
    getAgentProvider: () => {
      throw new Error('fake bridge: getAgentProvider not implemented');
    },
    loadConfig: async () => ({
      assistant: 'claude',
      commands: {},
      assistants: {
        claude: {},
        codex: {},
      },
    }),
  };

  const bridge: BridgeDeps = {
    workflowDeps,
    platform,
    resolveWorkflow: (name, cwd) => resolveWorkflow(name, cwd),
    loadCodebase: async id => codebases.get(id) ?? null,
    resolveIsolation: async ({ codebase }) => ({ cwd: `${codebase.default_cwd}/.archon/wt` }),
    createWorkerConversation: async input => {
      convCounter += 1;
      const id = `conv-db-${String(convCounter)}`;
      const conv: BridgeConversation = {
        id,
        platform_conversation_id: input.platformConversationId,
      };
      conversations.push(conv);
      if (opts.db) {
        await opts.db.query(
          `INSERT INTO remote_agent_conversations
             (id, platform_type, platform_conversation_id, codebase_id, cwd)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, 'web', input.platformConversationId, input.codebaseId, input.cwd]
        );
      }
      return conv;
    },
    runWorkflow: input => {
      runs.push({ input });
      return runWorkflowFn(input);
    },
  };

  return {
    bridge,
    store,
    platform,
    emitter,
    runs,
    codebases,
    conversations,
    setRunWorkflow(fn) {
      runWorkflowFn = fn;
    },
    setResolveWorkflow(fn) {
      resolveWorkflow = fn;
    },
  };
}

/**
 * Minimal `WorkflowDefinition` stub — only the fields the dispatcher actually
 * passes through. Tests that need the full Zod-validated shape should import
 * from `@archon/workflows/schemas/workflow`.
 */
export function makeFakeWorkflowDefinition(name: string): WorkflowDefinition {
  return {
    name,
    description: `Fake ${name}`,
    nodes: [],
  } as unknown as WorkflowDefinition;
}

/** Synthesize a fake `WorkflowExecutionResult` for runWorkflow stubs. */
export function fakeWorkflowResult(
  runId: string,
  success: boolean,
  message?: string
): WorkflowExecutionResult {
  if (success) {
    return { success: true, workflowRunId: runId, summary: message };
  }
  return { success: false, workflowRunId: runId, error: message ?? 'fake failure' };
}
