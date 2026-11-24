import { afterEach, expect, test } from 'bun:test';
import { invalidate, subscribeKey } from '../store/cache';
import { cancelRereads, scheduleReread } from './merge-reread';

afterEach(() => {
  cancelRereads();
  invalidate('merge-reread-test');
});

const turn = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

test('two schedules for one key reload it once', async () => {
  let loads = 0;
  const unsubscribe = subscribeKey(
    'merge-reread-test:a',
    () => undefined,
    async () => ++loads
  );
  try {
    await turn();
    expect(loads).toBe(1);
    scheduleReread('merge-reread-test:a', 0);
    scheduleReread('merge-reread-test:a', 0);
    await turn(5);
    expect(loads).toBe(2);
    // The timer is spent: a later schedule reloads again.
    scheduleReread('merge-reread-test:a', 0);
    await turn(5);
    expect(loads).toBe(3);
  } finally {
    unsubscribe();
  }
});

test('a cancelled re-read never reloads', async () => {
  let loads = 0;
  const unsubscribe = subscribeKey(
    'merge-reread-test:b',
    () => undefined,
    async () => ++loads
  );
  try {
    await turn();
    scheduleReread('merge-reread-test:b', 0);
    cancelRereads();
    await turn(5);
    expect(loads).toBe(1);
  } finally {
    unsubscribe();
  }
});
