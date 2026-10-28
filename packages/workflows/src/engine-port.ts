import type { IWorkflowPlatform } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import type { WorkflowEventCursor, WorkflowResumeCursor } from './store';
import type { WorkflowEventRow } from './schemas/workflow-event';
import type { ResolvedWorkflow, WorkflowRun, WorkflowExecutionResult } from './schemas';
import type { AttentionLabels } from './schemas/wait-node';
import type { AttentionQueueScope } from './attention-queue';
import type { AttentionStreamLine } from './attention-watch';

/** Publication relinquishes execution ownership even if subsequent work rejects. */
export class WorkflowExecutionHandoffError extends Error {
  constructor(
    readonly workflowRunId: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WorkflowExecutionHandoffError';
  }
}

// These lists own both the public input exclusions and their runtime validation.
export const FRESH_RUN_FORBIDDEN_OPTIONS = [
  'priorCompletedNodes',
  'priorFailedNodes',
  'resumeCause',
  'priorUsage',
  'priorNodeSessions',
] as const satisfies readonly (keyof ExecuteWorkflowOptions)[];

export const RESUME_FORBIDDEN_OPTIONS = [
  ...FRESH_RUN_FORBIDDEN_OPTIONS,
  'preCreatedRun',
  'runConfig',
  'preparedAiConfiguration',
  'modelOverrideLayer',
  'inputs',
  'preparedSource',
  'capturedSourceOwner',
  'adoptedFromRunId',
  'continuationMode',
  'cutFromCommit',
] as const satisfies readonly (keyof ExecuteWorkflowOptions)[];

type WithoutOptions<Key extends keyof ExecuteWorkflowOptions> = Omit<ExecuteWorkflowOptions, Key> &
  Partial<Record<Key, never>>;

export type WorkflowSubmitOptions = WithoutOptions<(typeof FRESH_RUN_FORBIDDEN_OPTIONS)[number]>;
export type WorkflowResumeOptions = WithoutOptions<(typeof RESUME_FORBIDDEN_OPTIONS)[number]>;

interface WorkflowEngineCallBase {
  platform: IWorkflowPlatform;
  conversationId: string;
  cwd: string;
  userMessage: string;
  origin?: import('./schemas/workflow-run').WorkflowRunOrigin;
}

export interface WorkflowEngineSubmitInput extends WorkflowEngineCallBase {
  workflow: ResolvedWorkflow;
  /** A pre-created row must still be pending; replay state belongs to resume. */
  options?: WorkflowSubmitOptions;
}

export interface WorkflowResumeInput extends WorkflowEngineCallBase {
  run: WorkflowRun;
  /** Used only for runs created before frozen workflow-source captures existed. */
  legacyWorkflow?: ResolvedWorkflow;
  cursor?: WorkflowResumeCursor;
  options?: WorkflowResumeOptions;
  /**
   * Runs after committed admission; rejection fails the admitted run.
   * Returns the full execution context, replacing the caller's cwd and options.
   * The returned options and isolation context are validated before execution.
   */
  prepareExecution?: (run: WorkflowRun) => Promise<{
    cwd: string;
    options?: WorkflowResumeOptions;
  }>;
}

export type WorkflowResumeAdmission =
  | { accepted: false; reason: 'nothing-to-resume' }
  | {
      accepted: true;
      runId: string;
      /** Settles this execution segment, which may pause rather than finish the run. */
      settled: Promise<WorkflowExecutionResult>;
    };

/** One committed event of the subscribed run tree. Resubscribing `after` its cursor continues the feed. */
export interface WorkflowRunDelivery {
  cursor: WorkflowEventCursor;
  event: WorkflowEventRow;
}

export interface WorkflowRunSubscriptionOptions {
  /** Start after this cursor instead of at the current head. */
  after?: WorkflowEventCursor;
  pollIntervalMs?: number;
}

export interface WorkflowRunSubscription {
  /** Drains to the head once more, then stops. Rejects if that final read fails. Idempotent. */
  close(): Promise<void>;
}

/**
 * A host's early wake for new events in the feed, whatever run they belong to. Resolves
 * to an unsubscribe, or null when the host has no notifications; polling still runs.
 */
export type WorkflowEventDoorbell = (onEvent: () => void) => Promise<(() => void) | null>;

export interface AttentionWatchOptions {
  /** Replay from this cursor, after the snapshot, instead of starting at the head. */
  after?: WorkflowEventCursor;
  scope: AttentionQueueScope;
  /** Exact label matches for `attention` and `resolved` lines; every one must hold. */
  labels?: Readonly<AttentionLabels>;
  pollIntervalMs?: number;
}

export interface AttentionWatch {
  /** Stops the watch and waits for lines in flight. Idempotent. */
  close(): Promise<void>;
}

/** Hosts supply execution context; the implementation owns its dependencies. */
export interface IWorkflowEngine {
  submit(input: WorkflowEngineSubmitInput): Promise<WorkflowExecutionResult>;
  /** Claims and starts a continuation before returning acceptance. */
  resume(input: WorkflowResumeInput): Promise<WorkflowResumeAdmission>;
  /**
   * Deliver every committed event of `runId` and of its descendant runs, in commit order,
   * one at a time; a throwing listener is logged and delivery continues. Resolves once the
   * starting cursor is fixed. Observes only: a delivered event can later be retracted by
   * recovery, so run reads remain the state of record.
   */
  subscribe(
    runId: string,
    listener: (delivery: WorkflowRunDelivery) => void,
    options?: WorkflowRunSubscriptionOptions
  ): Promise<WorkflowRunSubscription>;
  /**
   * Stream the attention queue across every run in scope, including runs started later:
   * the open items as a snapshot, then `ready`, then follow committed changes. Repeated
   * projection failures send identifier-free `degraded` lines at the last handled cursor.
   * Unreadable deliveries may be omitted after an independent fresh projection succeeds;
   * outages affecting all projections retain the cursor and retry. Reconnect after repair
   * for a fresh open set, or replay from before the gap for history. Later bookmarks do
   * not restore coverage. Readable delivery is at least once and one line at a time;
   * the listener's promise is awaited before the next line. Observes only: no run state
   * is written. Startup resolves after the listener accepts the snapshot and `ready`;
   * an initial listener failure rejects with its cause before background watches start. Rejects with
   * `WorkflowEventCursorError`, before any line, when `after` cannot be read; a tail that
   * later cannot read its own cursor sends an `error` line and stops.
   */
  watchAttention(
    listener: (line: AttentionStreamLine) => void | Promise<void>,
    options: AttentionWatchOptions
  ): Promise<AttentionWatch>;
}
