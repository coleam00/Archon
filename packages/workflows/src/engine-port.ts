/**
 * IWorkflowEngine — port abstracting workflow execution behind a narrow trait
 * interface, mirroring the `IWorkflowStore` / `IWorkflowPlatform` style: all-Promise
 * methods, id-first params, Result-object returns, narrow traits composed via
 * `extends`.
 *
 * `InProcessWorkflowEngine` (`./in-process-engine`) implements it by delegating
 * to `executeWorkflow` / `hydrateResumableRun`, and `./engine-contract-tests`
 * exercises any implementation against the port's contract.
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
 *   fire-and-forget `void`, because the CLI/orchestrator foreground callers
 *   already await a run's result and must keep doing so.
 */
import type { WorkflowDeps, IWorkflowPlatform } from './deps';
import type { ExecuteWorkflowOptions } from './executor';
import type { WorkflowResumeCursor } from './store';
import type { ResolvedWorkflow, WorkflowRun, WorkflowExecutionResult } from './schemas';

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
 * `hydrateResumableRun`'s `candidate` and `cursor` params; the implementation
 * hydrates them (`hydrateResumableRun(deps, run, cursor)`) and spreads the
 * result into `options` before calling `executeWorkflow`, which is what the
 * resume call sites used to do by hand.
 */
export interface WorkflowResumeInput extends WorkflowEngineCallBase {
  run: WorkflowRun;
  cursor?: WorkflowResumeCursor;
  options?: ExecuteWorkflowOptions;
}

/**
 * Port abstracting workflow execution. Implementations live behind this trait
 * so callers (CLI, orchestrator, adapters) depend only on the interface, never
 * on `executeWorkflow` / `dag-executor.ts` internals directly.
 */
export interface IWorkflowEngine {
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
   *
   * It applies ONLY to a run still in `running`. When the run has already moved
   * on — terminal, paused at a gate, or already cancelled — this resolves
   * `{ cancelled: false }` and never throws, which is what makes a repeated
   * signal (or a signal racing the executor committing a gate pause) safe.
   *
   * Discarding a run that is NOT running is deliberately not this port's job:
   * that is a different operation, owned by `abandonWorkflow`
   * (`@archon/core`'s workflow operations), which also performs cascade and
   * container reclaim.
   *
   * NOTE: this method currently has no in-repo production caller; it is part of
   * the port's contract and is covered by the engine contract tests. The CLI
   * interrupt handler is the obvious candidate, but it deliberately still
   * records `failed`, because `resumableStatusClause`
   * (`packages/core/src/db/workflows.ts`) treats `failed` and `paused` as
   * resumable and excludes `cancelled` — routing Ctrl-C through `cancel()`
   * would silently discard every completed node of the interrupted run.
   * Moving that call site here requires deciding what resumability should mean
   * for a cancelled run first.
   */
  cancel(runId: string, reason?: string): Promise<{ cancelled: boolean }>;
}
