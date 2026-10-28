import { describe, expect, it } from 'bun:test';
import {
  DETACHED_RUN_FAILED_EXIT_CODE,
  resolveCliExitCode,
  WorkflowRunFailedError,
} from './workflow-exit-code';

/**
 * The launcher/child exit-status protocol behind the startup window. The window can only
 * see that the child's process is gone; whether the run ever started is the child's to
 * report, and this is the channel it reports on.
 */
describe('resolveCliExitCode', () => {
  it('reserves a distinct status for a detached child reporting its own run failure', () => {
    expect(resolveCliExitCode(new WorkflowRunFailedError('node failed', true))).toBe(
      DETACHED_RUN_FAILED_EXIT_CODE
    );
  });

  it('keeps the ordinary status for a run that failed on a terminal', () => {
    expect(resolveCliExitCode(new WorkflowRunFailedError('node failed', false))).toBe(1);
  });

  it('reads the run outcome through a continuation command re-throw', () => {
    // `resume`/`approve`/`reject`/`respond` re-throw with their own explanation, so the
    // outermost error is never the run's. Losing the cause here would make every
    // detached continuation of a fast-failing run look like a launch failure again.
    const wrapped = new Error("Approved but failed to resume workflow 'assist': Workflow failed", {
      cause: new WorkflowRunFailedError('node failed', true),
    });
    expect(resolveCliExitCode(wrapped)).toBe(DETACHED_RUN_FAILED_EXIT_CODE);
  });

  it('reports a failure that is not a run outcome as an ordinary failure', () => {
    // The startup deaths #2914 exists to surface land here: the launcher must keep
    // reading these as a launch that never took.
    expect(resolveCliExitCode(new Error('Cannot determine git remote'))).toBe(1);
    expect(resolveCliExitCode('not an error')).toBe(1);
  });
});
