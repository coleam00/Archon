import { describe, expect, test } from 'bun:test';

import { AsyncQueue } from './async-queue';

describe('AsyncQueue', () => {
  test('rejects undefined items explicitly', () => {
    const queue = new AsyncQueue<unknown>();

    expect(() => queue.push(undefined)).toThrow(
      'AsyncQueue cannot enqueue undefined; use null or a caller-owned sentinel object'
    );
  });

  test('yields queued items until closed', async () => {
    const queue = new AsyncQueue<string>();
    queue.push('first');
    queue.push('second');
    queue.close();

    const items: string[] = [];
    for await (const item of queue) {
      items.push(item);
    }

    expect(items).toEqual(['first', 'second']);
  });
});
