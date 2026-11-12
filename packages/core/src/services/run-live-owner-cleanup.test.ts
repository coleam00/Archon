import { expect, test } from 'bun:test';
import { withRunLiveOwnerCleanup } from './run-live-owner-cleanup';

test('retains the body and shutdown errors through the owner failure channel', async () => {
  const failure = new Error('request state uncertain');
  const shutdown = new Error('owner socket removal failed');
  const error: unknown = await withRunLiveOwnerCleanup(
    async () => {
      throw shutdown;
    },
    async () => {
      throw failure;
    }
  ).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Missing combined failure');
  expect(error.errors).toEqual([failure, shutdown]);
  expect(error.message).toContain(failure.message);
  expect(error.message).toContain(shutdown.message);
});

test('closes once and preserves a successful result or a single failure', async () => {
  let closed = 0;
  const close = async (): Promise<void> => {
    closed++;
  };
  expect(await withRunLiveOwnerCleanup(close, async () => 'result')).toBe('result');
  expect(closed).toBe(1);
  const failure = new Error('body failed');
  await expect(
    withRunLiveOwnerCleanup(close, async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
  expect(closed).toBe(2);
  const shutdown = new Error('shutdown failed');
  await expect(
    withRunLiveOwnerCleanup(
      async () => {
        throw shutdown;
      },
      async () => 'result'
    )
  ).rejects.toBe(shutdown);
});
