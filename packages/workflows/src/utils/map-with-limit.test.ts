import { describe, it, expect } from 'bun:test';
import { mapWithLimit } from './map-with-limit';

/** Resolve after a microtask-ish delay so concurrency is actually observable. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('mapWithLimit', () => {
  it('returns results in INPUT order regardless of settle order', async () => {
    // Later items settle FIRST (inverse delay) — output must still be item order.
    const items = [0, 1, 2, 3, 4];
    const results = await mapWithLimit(items, 5, async n => {
      await delay((items.length - n) * 5);
      return n * 10;
    });
    expect(results.map(r => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      0, 10, 20, 30, 40,
    ]);
  });

  it('never exceeds the concurrency limit (sliding window)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithLimit(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });
    expect(maxInFlight).toBe(3);
  });

  it('isolates errors — one rejection does not abort the rest', async () => {
    const results = await mapWithLimit([0, 1, 2, 3], 2, async n => {
      if (n === 1) throw new Error(`boom ${n}`);
      return n;
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 0 });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((results[1] as PromiseRejectedResult).reason)).toContain('boom 1');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[3]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('runs every item exactly once and passes the correct index', async () => {
    const seenIndexes: number[] = [];
    const items = ['a', 'b', 'c', 'd', 'e'];
    const results = await mapWithLimit(items, 2, async (item, index) => {
      seenIndexes.push(index);
      return `${item}:${String(index)}`;
    });
    expect([...seenIndexes].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(results.map(r => (r.status === 'fulfilled' ? r.value : null))).toEqual([
      'a:0',
      'b:1',
      'c:2',
      'd:3',
      'e:4',
    ]);
  });

  it('handles an empty item list', async () => {
    let called = false;
    const results = await mapWithLimit([], 5, async () => {
      called = true;
      return 1;
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('clamps a limit larger than the item count (no idle workers spin)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [0, 1];
    await mapWithLimit(items, 100, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });
    // Only 2 items → at most 2 concurrent even though the cap was 100.
    expect(maxInFlight).toBe(2);
  });

  it('coerces a non-positive limit to serial rather than throwing', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [0, 1, 2];
    const results = await mapWithLimit(items, 0, async n => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(3);
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBe(1);
    expect(results.map(r => (r.status === 'fulfilled' ? r.value : null))).toEqual([0, 1, 2]);
  });
});
