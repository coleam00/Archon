/**
 * IWorkflowEngine — port abstracting workflow execution behind a narrow trait
 * interface, mirroring the `IWorkflowStore` / `IWorkflowPlatform` style: all-Promise
 * methods, id-first params, Result-object returns, narrow traits composed via
 * `extends`.
 *
 * This is a pure type addition (issue #3334, M0). Nothing in the package imports
 * it yet; `executeWorkflow` / `hydrateResumableRun` remain the only call path
 * until a later milestone wires an `InProcessWorkflowEngine` implementation
 * behind this port.
 *
 * `WorkflowEngineSubmitInput` / `WorkflowResumeInput` are thin re-shapings of the
 * existing `executeWorkflow` positional args + `ExecuteWorkflowOptions`, and of
 * `hydrateResumableRun`'s `(deps, candidate, cursor)` signature — no new fields,
 * no new behavior.
 *
 * Two deliberate divergences from a sibling project's analogous Temporal-backed
 * workflow-engine port (rationale only; nothing here imports or references that
 * project):
 * - `resume()` stays an explicit method rather than being folded into automatic
 *   replay, because Archon resume is a DB compare-and-swap over a persisted run
 *   row (`IWorkflowStore.resumeWorkflowRun`), not event-sourced replay.
 * - `submit()` returns `Promise<WorkflowExecutionResult>` rather than being
 *   fire-and-forget `void`, because the current CLI/orchestrator foreground
 *   callers already `await` `executeWorkflow`'s result and must keep doing so.
 */
import type { WorkflowDeps, IWorkflowPlatform } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import type { WorkflowResumeCursor } from './store';
import type { WorkflowEmitterEvent } from './event-emitter';
import type { ResolvedWorkflow, WorkflowRun, WorkflowExecutionResult } from './schemas';

/** Alias kept local to the port so callers of `IWorkflowEngine` don't need to know
 * events are currently backed by `WorkflowEmitterEvent`; that's an implementation
 * detail of whichever engine backs the port. */
export type WorkflowEvent = WorkflowEmitterEvent;

/**
 * Shared positional identity + dependencies every submit/resume call needs,
 * mirroring `executeWorkflow`'s required args.
 */
interface WorkflowEngineCallBase {
  deps: WorkflowDeps;
  platform: IWorkflowPlatform;
  conversationId: string;
  cwd: string;
  workflow: ResolvedWorkflow;
  userMessage: string;
  conversationDbId: string;
}

/**
 * Input to {@link IWorkflowEngine.submit}. `options` is exactly
 * `executeWorkflow`'s trailing `ExecuteWorkflowOptions` — the port does not
 * re-invent that shape, only re-groups the positional args alongside it.
 */
export interface WorkflowEngineSubmitInput extends WorkflowEngineCallBase {
  options?: ExecuteWorkflowOptions;
}

/**
 * Input to {@link IWorkflowEngine.resume}. `run` and `cursor` are exactly
 * `hydrateResumableRun`'s `candidate` and `cursor` params; an implementation
 * hydrates them (`hydrateResumableRun(deps, run, cursor)`) and spreads the
 * result into `options` before calling `executeWorkflow`, same as today's call
 * sites do manually.
 */
export interface WorkflowResumeInput extends WorkflowEngineCallBase {
  run: WorkflowRun;
  cursor?: WorkflowResumeCursor;
  options?: ExecuteWorkflowOptions;
}

/**
 * Read-only event subscription, kept as its own trait (ISP, same reasoning as
 * `IRunTreeStore` being split out of `IWorkflowStore`) so a caller that only
 * needs to observe a run doesn't have to depend on submit/resume/cancel.
 */
export interface IWorkflowEventStream {
  /**
   * Subscribe to events for `runId` AND every descendant sub-run reachable from
   * it (resolved via `IRunTreeStore`'s `parent_run_id` walk) — NOT events keyed
   * by conversation id. A `workflow:` node's child run's events must reach a
   * subscriber on the parent run id the same way they reach the conversation
   * today.
   *
   * An implementation MUST be satisfiable by reading through `IWorkflowStore`'s
   * event-read methods only; it must never query a database directly. Returns
   * an unsubscribe function.
   */
  subscribe(runId: string, listener: (event: WorkflowEvent) => void): () => void;
}

/**
 * Port abstracting workflow execution. Implementations live behind this trait
 * so callers (CLI, orchestrator, adapters) depend only on the interface, never
 * on `executeWorkflow` / `dag-executor.ts` internals directly.
 */
export interface IWorkflowEngine extends IWorkflowEventStream {
  /** Start a new workflow run. Equivalent to today's `executeWorkflow(...)` call
   * with no resume state in `options`. */
  submit(input: WorkflowEngineSubmitInput): Promise<WorkflowExecutionResult>;

  /** Resume a previously paused/interrupted run. Equivalent to today's
   * `hydrateResumableRun(...)` followed by `executeWorkflow(..., { ...hydrated })`.
   *
   * `opts.onAccepted` (optional) fires synchronously once hydration has
   * succeeded and execution is about to start — i.e. the same "fast phase
   * done, slow phase starting" boundary `dispatchBackgroundWorkflowOwned`
   * (`packages/core/src/orchestrator/orchestrator.ts`) already relies on at
   * its own call sites, exposed here through the port instead of being
   * re-implemented ad hoc by every caller that needs a quick "was this
   * accepted" signal without waiting for the full run to finish. A caller
   * that omits `onAccepted` sees no behavior change: it still just awaits
   * the returned `Promise<WorkflowExecutionResult>` to completion. */
  resume(
    input: WorkflowResumeInput,
    opts?: { onAccepted?: () => void }
  ): Promise<WorkflowExecutionResult>;

  /**
   * Request cancellation of `runId`. This is a COOPERATIVE request, not a
   * synchronous interrupt: the DAG execution loop only polls run/cancellation
   * status on a throttle (`CANCEL_CHECK_INTERVAL_MS`, currently 10s, in
   * `dag-executor.ts`), so a resolved `{ cancelled: true }` means the request
   * was recorded, not that execution has already stopped.
   */
  cancel(runId: string, reason?: string): Promise<{ cancelled: boolean }>;
}
