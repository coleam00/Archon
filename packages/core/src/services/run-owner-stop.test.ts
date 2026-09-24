import { describe, expect, it } from 'bun:test';
import { DetachedRunOwnerUnavailableError, requestDetachedRunStop } from './run-owner-stop';

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
