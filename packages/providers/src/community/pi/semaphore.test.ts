import { describe, expect, test } from 'bun:test';

import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  test('a waiter aborted while queued leaves the queue and never takes the slot', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    const abandoned = sem.acquire(controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toThrow();

    sem.release();
    let acquired = false;
    void sem.acquire().then(() => {
      acquired = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(acquired).toBe(true);
  });

  test('an already-aborted signal rejects without taking a free slot', async () => {
    const sem = new Semaphore(1);
    await expect(sem.acquire(AbortSignal.abort())).rejects.toThrow();
    let acquired = false;
    void sem.acquire().then(() => {
      acquired = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(acquired).toBe(true);
  });
});
