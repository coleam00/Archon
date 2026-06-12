import { DeliveryDeduplicator } from './delivery-dedup';

/** Deterministic clock: tests advance time explicitly instead of sleeping. */
function createClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('DeliveryDeduplicator', () => {
  test('first sighting of a key is not a duplicate', () => {
    const dedup = new DeliveryDeduplicator();
    expect(dedup.seen('comment:owner/repo#42:100:2026-06-12T00:00:00Z')).toBe(false);
  });

  test('repeat sighting within TTL is a duplicate', () => {
    const dedup = new DeliveryDeduplicator();
    const key = 'comment:owner/repo#42:100:2026-06-12T00:00:00Z';
    expect(dedup.seen(key)).toBe(false);
    expect(dedup.seen(key)).toBe(true);
    expect(dedup.seen(key)).toBe(true);
  });

  test('different keys do not collide', () => {
    const dedup = new DeliveryDeduplicator();
    expect(dedup.seen('comment:owner/repo#42:100:t1')).toBe(false);
    expect(dedup.seen('comment:owner/repo#42:101:t1')).toBe(false);
    expect(dedup.seen('comment:owner/repo#43:100:t1')).toBe(false);
  });

  test('same comment with new updated_at is not a duplicate (edit re-trigger)', () => {
    const dedup = new DeliveryDeduplicator();
    expect(dedup.seen('comment:owner/repo#42:100:2026-06-12T00:00:00Z')).toBe(false);
    expect(dedup.seen('comment:owner/repo#42:100:2026-06-12T00:05:00Z')).toBe(false);
  });

  test('key expires after TTL and may run again', () => {
    const clock = createClock();
    const dedup = new DeliveryDeduplicator(20, 10_000, clock.now);
    const key = 'delivery:guid-1';
    expect(dedup.seen(key)).toBe(false);
    expect(dedup.seen(key)).toBe(true);

    clock.advance(30);

    expect(dedup.seen(key)).toBe(false);
    expect(dedup.seen(key)).toBe(true);
  });

  test('key just inside the TTL window is still a duplicate', () => {
    const clock = createClock();
    const dedup = new DeliveryDeduplicator(20, 10_000, clock.now);
    expect(dedup.seen('k')).toBe(false);

    clock.advance(19);

    expect(dedup.seen('k')).toBe(true);
  });

  test('expired entries are pruned on insert', () => {
    const clock = createClock();
    const dedup = new DeliveryDeduplicator(20, 10_000, clock.now);
    dedup.seen('a');
    dedup.seen('b');
    expect(dedup.size).toBe(2);

    clock.advance(30);

    dedup.seen('c');
    expect(dedup.size).toBe(1); // a and b expired and pruned
  });

  test('evicts oldest entries past max size', () => {
    const dedup = new DeliveryDeduplicator(60_000, 3);
    dedup.seen('a');
    dedup.seen('b');
    dedup.seen('c');
    dedup.seen('d'); // evicts a

    expect(dedup.size).toBe(3);
    expect(dedup.seen('a')).toBe(false); // evicted, so first-seen again
    expect(dedup.seen('d')).toBe(true); // still tracked
  });

  test('re-seeing a key after expiry refreshes its eviction position', () => {
    const clock = createClock();
    const dedup = new DeliveryDeduplicator(20, 10, clock.now);
    dedup.seen('a');
    clock.advance(30);
    dedup.seen('b');
    dedup.seen('a'); // expired -> refreshed, moves behind b

    expect(dedup.seen('a')).toBe(true);
    expect(dedup.seen('b')).toBe(true);
    expect(dedup.size).toBe(2);
  });
});
