import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  commandTerminatedBySignal,
  DetachedRunOwnerUnavailableError,
  requestDetachedRunStop,
} from './detached-run-control';

const execFileAsync = promisify(execFile);

/** The real rejection `execFile` produces for `run`, so no error shape is hand-built. */
async function rejectionFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the command to reject');
}

describe('detached run control', () => {
  it('fails explicitly when no live owner is reachable', async () => {
    const runId = `missing-${crypto.randomUUID()}`;
    const error = await rejectionFrom(() => requestDetachedRunStop(runId));
    expect(error).toBeInstanceOf(DetachedRunOwnerUnavailableError);
  });
});

/**
 * The Windows termination path tolerates a kill command that ran and reported a
 * failure, because `taskkill /T` reports every tree member that had already exited.
 * It must never tolerate one that was cut off part-way, because then the tree was
 * only partly walked and the root going quiet says nothing about the descendants.
 *
 * Every error below is the genuine object Node produces, not a hand-built stand-in,
 * so this stays true if Node changes the shape.
 */
describe('commandTerminatedBySignal', () => {
  it('is true for a timeout, which cuts the command off part-way', async () => {
    const error = await rejectionFrom(() =>
      execFileAsync(process.execPath, ['-e', 'setTimeout(() => undefined, 30_000)'], {
        timeout: 100,
      })
    );

    // The distinction is structural, so assert the shape the classification rests on
    // rather than only its verdict — a Node change that moved it would surface here.
    expect(error).toMatchObject({ killed: true, signal: 'SIGTERM' });
    expect(commandTerminatedBySignal(error)).toBe(true);
  });

  it('is false for an ordinary non-zero exit, which is a completed walk', async () => {
    const error = await rejectionFrom(() =>
      execFileAsync(process.execPath, ['-e', 'process.exit(3)'])
    );

    expect(error).toMatchObject({ killed: false, code: 3 });
    expect(commandTerminatedBySignal(error)).toBe(false);
  });

  it('is false for a command that never started, which killed nothing', async () => {
    // Tolerated on purpose: nothing was signalled, so the root check that follows is
    // a conservative verdict — a live root still throws.
    const error = await rejectionFrom(() => execFileAsync('archon-no-such-binary-xyz', []));

    expect(error).toMatchObject({ code: 'ENOENT' });
    expect(commandTerminatedBySignal(error)).toBe(false);
  });

  it('is false for anything that is not an error object', () => {
    expect(commandTerminatedBySignal(undefined)).toBe(false);
    expect(commandTerminatedBySignal('killed')).toBe(false);
    expect(commandTerminatedBySignal({ signal: 1 })).toBe(false);
  });
});
