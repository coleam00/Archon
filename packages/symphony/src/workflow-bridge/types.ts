/**
 * Bridge dependency contracts.
 *
 * Symphony's dispatcher injects the Archon workflow plumbing through these
 * narrow interfaces so the orchestrator and dispatcher are unit-testable
 * without booting the full server. The shapes are structural subsets of the
 * real Archon types; production wiring satisfies them via direct deep imports
 * (`@archon/core/orchestrator/orchestrator`, `@archon/workflows/event-emitter`,
 * etc.) — see `packages/symphony/src/service.ts`.
 */
import type { IWorkflowPlatform, WorkflowDeps } from '@archon/workflows/deps';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { Issue } from '../tracker/types';
import type { ConfigSnapshot, TrackerKind } from '../config/snapshot';

/** Resolves a workflow name (from `state_workflow_map`) to a parsed definition. */
export type WorkflowResolver = (name: string, cwd: string) => Promise<WorkflowDefinition | null>;

/** Minimal codebase shape needed for isolation resolution + cwd lookup. */
export interface BridgeCodebase {
  id: string;
  name: string;
  default_cwd: string;
}

export type CodebaseLoader = (codebaseId: string) => Promise<BridgeCodebase | null>;

/** Worker conversation row created for a Symphony-launched workflow run. */
export interface BridgeConversation {
  /** Database UUID. */
  id: string;
  /** Platform conversation id (`symphony-…`). */
  platform_conversation_id: string;
}

/**
 * Create-or-fetch a worker conversation row for a Symphony dispatch. Mirrors
 * `conversationDb.getOrCreateConversation('web', platformId, codebaseId)` plus
 * `updateConversation(...)` to mark it hidden + set cwd.
 */
export type WorkerConversationFactory = (input: {
  platformConversationId: string;
  codebaseId: string;
  cwd: string;
}) => Promise<BridgeConversation>;

/** Resolves an isolated working directory for a worker conversation. */
export type IsolationResolver = (input: {
  conversation: BridgeConversation;
  codebase: BridgeCodebase;
  platform: IWorkflowPlatform;
}) => Promise<{ cwd: string }>;

/** Subset of `WebAdapter` we touch from the bridge. */
export interface BridgeWebAdapter extends IWorkflowPlatform {
  /** Required so `executeWorkflow` can persist worker messages to the right DB row. */
  setConversationDbId(platformConversationId: string, dbId: string): void;
}

/**
 * Wires the bridge to the live Archon plumbing. Service-side code constructs
 * one of these and hands it to the orchestrator at startup. Tests construct a
 * fake.
 */
export interface BridgeDeps {
  workflowDeps: WorkflowDeps;
  platform: BridgeWebAdapter;
  resolveWorkflow: WorkflowResolver;
  loadCodebase: CodebaseLoader;
  resolveIsolation: IsolationResolver;
  createWorkerConversation: WorkerConversationFactory;
  /**
   * Calls into `executeWorkflow(...)`. Injected so tests can stub it without
   * dragging in the real executor (which loads the AI provider stack).
   * Production passes a thin closure that calls `executeWorkflow` from
   * `@archon/workflows/executor`.
   */
  runWorkflow: RunWorkflowFn;
  /** Optional clock override for tests. */
  now?: () => number;
}

export type RunWorkflowFn = (input: RunWorkflowInput) => Promise<void>;

export interface RunWorkflowInput {
  workflow: WorkflowDefinition;
  workerPlatformId: string;
  workerConversationDbId: string;
  cwd: string;
  codebaseId: string;
  userMessage: string;
  preCreatedRunId: string;
  /**
   * Receives terminal status (`completed` / `failed` / `cancelled`) and the
   * error message if any. Implementations may resolve before the workflow
   * actually finishes (fire-and-forget) and rely on the event emitter for
   * status updates instead — see DispatcherSubscription.
   */
  signal: AbortSignal;
}

export interface DispatchOutcome {
  status: 'launched' | 'failed_no_codebase' | 'failed_no_workflow' | 'failed_db_conflict';
  /** Set when status === 'launched'. */
  workflowRunId?: string;
  /** Set when status === 'launched'. */
  dispatchId?: string;
  /** Set on failed_* outcomes. */
  reason?: string;
}

export interface DispatchInput {
  issue: Issue;
  trackerKind: TrackerKind;
  snap: ConfigSnapshot;
  attempt: number;
  /** Resolved by the orchestrator before calling the dispatcher. */
  codebaseId: string | null;
  abort: AbortController;
}
