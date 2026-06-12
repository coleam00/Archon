import { DeliveryDeduplicator } from './delivery-dedup';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

  test('key expires after TTL and may run again', async () => {
    const dedup = new DeliveryDeduplicator(20);
    const key = 'delivery:guid-1';
    expect(dedup.seen(key)).toBe(false);
    expect(dedup.seen(key)).toBe(true);

    await sleep(30);

    expect(dedup.seen(key)).toBe(false);
    expect(dedup.seen(key)).toBe(true);
  });

  test('expired entries are pruned on insert', async () => {
    const dedup = new DeliveryDeduplicator(20);
    dedup.seen('a');
    dedup.seen('b');
    expect(dedup.size).toBe(2);

    await sleep(30);

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

  test('re-seeing a key after expiry refreshes its eviction position', async () => {
    const dedup = new DeliveryDeduplicator(20, 10);
    dedup.seen('a');
    await sleep(30);
    dedup.seen('b');
    dedup.seen('a'); // expired -> refreshed, moves behind b

    expect(dedup.seen('a')).toBe(true);
    expect(dedup.seen('b')).toBe(true);
    expect(dedup.size).toBe(2);
  });
});
