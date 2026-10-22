import { isWorkflowExecutionInterruption } from '../execution-interruption';
import {
  assertWorkflowSourceIntegrity,
  isSourceReadFailure,
  isSystemError,
  WorkflowSourceUnavailableError,
  type WorkflowSourceRoots,
} from '../workflow-source';
import { loadCommandPrompt } from '../load-command-prompt';
import { NodeEventWriteError } from '../node-event-write';
import { RunBudgetRefusedError } from '../run-budget';
import { TerminalStatusWriteError } from '../terminal-status-write';
import { getLog } from './log';
import type { RunLayersContext } from './run-context';

/**
 * This host could not read the run's frozen source for a node (`isSourceReadFailure`).
 * Not a node outcome: it leaves the layer join like a budget refusal, and
 * `executeDagWorkflow` releases the run to be continued by a host that can read it.
 */
export class RunSourceUnreadableError extends Error {
  readonly path?: string;
  constructor(
    /** The node's persisted step name. */
    readonly nodeId: string,
    cause: unknown
  ) {
    const path =
      cause instanceof WorkflowSourceUnavailableError
        ? cause.path
        : isSystemError(cause) && typeof cause.path === 'string'
          ? cause.path
          : undefined;
    super(
      `This host could not read the run's source for node '${nodeId}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
    this.name = 'RunSourceUnreadableError';
    this.path = path;
  }
}

/** Verify the run's frozen source before a node reads it; a read failure releases the run. */
export async function assertNodeSourceReadable(
  roots: WorkflowSourceRoots,
  stepName: string
): Promise<ReadonlySet<string> | undefined> {
  try {
    return await assertWorkflowSourceIntegrity(roots);
  } catch (error) {
    if (isSourceReadFailure(error)) throw new RunSourceUnreadableError(stepName, error);
    throw error;
  }
}

export async function loadNodeCommandPrompt(
  ctx: RunLayersContext,
  command: string,
  stepName: string
): Promise<Awaited<ReturnType<typeof loadCommandPrompt>>> {
  const verifiedFiles = await assertNodeSourceReadable(ctx.workflowSourceRoots, stepName);
  try {
    const result = await loadCommandPrompt(
      ctx.deps,
      ctx.cwd,
      command,
      ctx.configuredCommandFolder,
      ctx.workflowSourceRoots,
      verifiedFiles
    );
    if (!result.success && isSourceReadFailure(result.cause, verifiedFiles)) {
      // Packaged commands resolve by path, so ENOENT can also mean an authored command
      // never existed. Only a file in the verified capture was lost on this host.
      if (
        result.reason === 'not_found' &&
        !(
          isSystemError(result.cause) &&
          typeof result.cause.path === 'string' &&
          verifiedFiles?.has(result.cause.path)
        )
      )
        return result;
      throw result.cause;
    }
    return result;
  } catch (error) {
    if (isSourceReadFailure(error, verifiedFiles))
      throw new RunSourceUnreadableError(stepName, error);
    throw error;
  }
}

/** Preserve the rejection that determines run recovery after all claimed work settles. */
export function settledValuesOrThrow<T>(
  results: readonly PromiseSettledResult<T>[],
  workflowRunId: string
): T[] {
  const values: T[] = [];
  const failures: PromiseRejectedResult[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') values.push(result.value);
    else failures.push(result);
  }
  const selected =
    failures.find(result => result.reason instanceof TerminalStatusWriteError) ??
    failures.find(result => result.reason instanceof NodeEventWriteError) ??
    failures.find(result => isWorkflowExecutionInterruption(result.reason)) ??
    failures.find(result => result.reason instanceof RunBudgetRefusedError) ??
    failures.find(result => result.reason instanceof RunSourceUnreadableError) ??
    failures[0];
  if (selected === undefined) return values;
  for (const failure of failures) {
    if (failure === selected) continue;
    const reason: unknown = failure.reason;
    getLog().error({ err: reason, workflowRunId }, 'dag.join_secondary_failure');
  }
  throw selected.reason;
}
