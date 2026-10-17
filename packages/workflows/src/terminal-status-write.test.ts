// @archon-test-isolated
/**
 * The wrapper is the only place a terminal status-write failure is diagnosed.
 *
 * It replaced ~14 per-site `.catch()` handlers that each logged their own tagged
 * line; if the wrapper stops logging, the original database error travels silently
 * inside `.cause` until some caller frames away happens to log the rejection.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const logError = mock((..._args: unknown[]) => undefined);
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => ({
    fatal: mock(() => undefined),
    error: logError,
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
  })),
}));

const { TerminalStatusWriteError, requireTerminalStatusWrite } = await import(
  './terminal-status-write'
);

describe('requireTerminalStatusWrite', () => {
  beforeEach(() => {
    logError.mockClear();
  });

  it('passes a successful write through untouched and logs nothing', async () => {
    await expect(
      requireTerminalStatusWrite(Promise.resolve('ok'), {
        workflowRunId: 'run-1',
        site: 'test.site',
      })
    ).resolves.toBe('ok');

    expect(logError).not.toHaveBeenCalled();
  });

  it('logs the original error with its run id and site, then rethrows the marker', async () => {
    const cause = new Error('SQLITE_BUSY: database is locked');

    const rejection = requireTerminalStatusWrite(Promise.reject(cause), {
      workflowRunId: 'run-1',
      site: 'executor.backstop_fail_failed',
    });
    await expect(rejection).rejects.toBeInstanceOf(TerminalStatusWriteError);

    expect(logError).toHaveBeenCalledTimes(1);
    const [context, tag] = logError.mock.calls[0] as [Record<string, unknown>, string];
    expect(context.err).toBe(cause);
    expect(context.workflowRunId).toBe('run-1');
    expect(context.site).toBe('executor.backstop_fail_failed');
    expect(tag).toBe('workflow.terminal_status_write_failed');
  });

  it('keeps the original error reachable as the marker cause', async () => {
    const cause = new Error('disk full');

    await expect(
      requireTerminalStatusWrite(Promise.reject(cause), { workflowRunId: 'r', site: 's' })
    ).rejects.toMatchObject({ cause });
  });
});
