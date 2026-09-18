/**
 * InProcessWorkflowEngine — the first `IWorkflowEngine` implementation
 * (issue #3334, M1). `submit`/`resume` are a thin re-shaping wrapper: they
 * delegate 1:1 to today's `executeWorkflow` / `hydrateResumableRun` call
 * path, with no behavior changes. `cancel` is out of this milestone's scope
 * (M7) and throws an explicit not-implemented error — nothing calls it yet.
 *
 * `cancel()` (#3334 M7) is also real: it delegates to `IWorkflowStore.cancelWorkflowRun`,
 * which is backed by `@archon/core`'s idempotent `cancelWorkflowRun` (guards
 * `status NOT IN ('completed', 'cancelled')`, never throws on a double-cancel).
 * `@archon/workflows` cannot import `@archon/core` directly (core depends on
 * workflows, not the reverse), so `cancel()` requires a
 * store-bound engine instance: `new InProcessWorkflowEngine(deps.store)`.
 */
import { executeWorkflow, hydrateResumableRun } from './executor';
import type {
  IWorkflowEngine,
  WorkflowEngineSubmitInput,
  WorkflowResumeInput,
} from './engine-port';
import type { IWorkflowStore } from './store';
import type { WorkflowExecutionResult } from './schemas';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.in-process-engine');
  return cachedLog;
}

/**
 * Wraps any error `hydrateResumableRun` throws other than a lost CAS race
 * (`WorkflowNotResumableError`, recognized by name and left unwrapped — see
 * `resume()`'s doc comment below). A caller that folds hydrate+execute into
 * one `resume()` call otherwise has no way to tell "resume never got past
 * hydration" apart from "hydration succeeded, then execution itself failed"
 * — both surface as a rejected `Promise`, and the underlying error can be the
 * same generic `Error` class either way. `cause` carries the original error
 * for logging; callers that need to react differently to a hydration-phase
 * failure should check `instanceof WorkflowResumeHydrationError` before
 * falling back to their generic-error handling (#3334 M2).
 */
export class WorkflowResumeHydrationError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'WorkflowResumeHydrationError';
  }
}

export class InProcessWorkflowEngine implements IWorkflowEngine {
  /**
   * `store` is optional so every existing `new InProcessWorkflowEngine()` call
   * site (which passes `deps`/`store` per-call to `submit`/`resume` instead)
   * keeps working unchanged. `cancel()` has no such per-call parameter (the
   * `IWorkflowEngine` port fixes its signature to `(runId, reason)`), so a
   * caller that needs it must construct the engine with a store:
   * `new InProcessWorkflowEngine(deps.store)`.
   */
  constructor(private readonly store?: IWorkflowStore) {}

  async submit(input: WorkflowEngineSubmitInput): Promise<WorkflowExecutionResult> {
    const {
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversationDbId,
      options,
    } = input;
    return executeWorkflow(
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversationDbId,
      options
    );
  }

  async resume(
    input: WorkflowResumeInput,
    opts?: { onAccepted?: () => void }
  ): Promise<WorkflowExecutionResult> {
    const {
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversationDbId,
      run,
      cursor,
      options,
    } = input;
    // Mirrors workflow-resume-service.ts / executor.ts's own resume call sites:
    // hydrateResumableRun first, then spread the hydrated state into opts.
    // A lost CAS race throws (WorkflowNotResumableError) and is intentionally
    // left unwrapped here — callers already know how to recognize it by type
    // (`err.name === 'WorkflowNotResumableError'`), same as today's call sites.
    // Any other hydrate-phase error is wrapped in `WorkflowResumeHydrationError`
    // so callers can distinguish it from an execute-phase failure (see that
    // class's doc comment).
    let hydrated: Awaited<ReturnType<typeof hydrateResumableRun>>;
    try {
      hydrated = await hydrateResumableRun(deps, run, cursor);
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkflowNotResumableError') {
        throw error;
      }
      throw new WorkflowResumeHydrationError(error);
    }
    if (hydrated === null) {
      // Every existing call site treats "nothing to hydrate" as "do not start
      // execution" (see workflow-resume-service.ts and the parent-auto-resume
      // path in executor.ts), but they return `boolean`/`void`, not a
      // WorkflowExecutionResult. This port method must return one, so it is
      // surfaced as an explicit failure rather than silently starting a fresh
      // run under resume semantics.
      return {
        success: false,
        workflowRunId: run.id,
        error: 'Nothing to resume: candidate run has no completed nodes or wait state',
      };
    }
    // Hydration succeeded and execution is about to start — the fast/slow
    // boundary `opts.onAccepted` exists for (see engine-port.ts's doc comment).
    // The run row is already claimed (`running`) at this point, so a throwing
    // callback must never block `executeWorkflow` from starting — that would
    // leave the claimed run stuck with no active execution. Log and continue.
    try {
      opts?.onAccepted?.();
    } catch (error) {
      getLog().error(
        { err: error as Error, runId: run.id },
        'in_process_engine.on_accepted_failed'
      );
    }
    return executeWorkflow(
      deps,
      platform,
      conversationId,
      cwd,
      workflow,
      userMessage,
      conversationDbId,
      {
        ...options,
        ...hydrated,
      }
    );
  }

  async cancel(runId: string, reason?: string): Promise<{ cancelled: boolean }> {
    if (!this.store) {
      throw new Error(
        'IWorkflowEngine.cancel requires a store-bound engine instance — ' +
          'construct with `new InProcessWorkflowEngine(deps.store)`'
      );
    }
    // Delegates 1:1 to the store's idempotent cancelWorkflowRun (see class doc
    // comment above) — this is a cooperative request only (see engine-port.ts's
    // doc comment on IWorkflowEngine.cancel): the DAG loop observes it on its
    // own poll throttle, so a resolved `{ cancelled: true }` means "recorded",
    // not "execution has already stopped".
    return this.store.cancelWorkflowRun(runId, reason === undefined ? undefined : { reason });
  }
}
