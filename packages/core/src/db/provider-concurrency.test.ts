import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapter } from './adapters/sqlite';
import { ProviderConcurrencyGate } from './provider-concurrency';

const tempDirs: string[] = [];
const openDatabases: SqliteAdapter[] = [];

function sharedDatabase(): [SqliteAdapter, SqliteAdapter] {
  const dir = mkdtempSync(join(tmpdir(), 'archon-provider-concurrency-'));
  tempDirs.push(dir);
  const path = join(dir, 'archon.db');
  const first = new SqliteAdapter(path);
  const second = new SqliteAdapter(path);
  openDatabases.push(first, second);
  return [first, second];
}

function gate(db: SqliteAdapter): ProviderConcurrencyGate {
  return new ProviderConcurrencyGate(db, {
    leaseMs: 10_000,
    heartbeatMs: 2_000,
    pollMs: 1,
  });
}

afterEach(async () => {
  for (const db of openDatabases.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ProviderConcurrencyGate', () => {
  test('coordinates a cap across independent SQLite connections', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const first = await gate(firstDb).acquire('pi', 1);

    let queued = false;
    let admitted = false;
    const secondPromise = gate(secondDb)
      .acquire('pi', 1, {
        observer: {
          onQueued: () => {
            queued = true;
          },
        },
      })
      .then(lease => {
        admitted = true;
        return lease;
      });

    while (!queued) await Bun.sleep(1);
    expect(admitted).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(admitted).toBe(true);
    expect(second.slot).toBe(0);
    await second.release();
  });

  test('different providers use independent slot pools', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const pi = await gate(firstDb).acquire('pi', 1);
    const claude = await gate(secondDb).acquire('claude', 1);

    expect(pi.slot).toBe(0);
    expect(claude.slot).toBe(0);
    await pi.release();
    await claude.release();
  });

  test('aborts a queued waiter without disturbing the live owner', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const first = await gate(firstDb).acquire('pi', 1);
    const controller = new AbortController();
    let queued = false;
    const waiter = gate(secondDb).acquire('pi', 1, {
      signal: controller.signal,
      observer: {
        onQueued: () => {
          queued = true;
        },
      },
    });

    while (!queued) await Bun.sleep(1);
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });

    const rows = await firstDb.query<{ lease_id: string }>(
      `SELECT lease_id FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(rows.rowCount).toBe(1);
    await first.release();
  });

  test('reclaims an expired slot and stale release cannot remove its successor', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    await firstDb.query(
      `INSERT INTO remote_agent_provider_slots
         (provider_id, slot_index, lease_id, lease_expires_at)
       VALUES ($1, $2, $3, $4)`,
      ['pi', 0, 'expired-owner', '2000-01-01T00:00:00.000Z']
    );

    const successor = await gate(secondDb).acquire('pi', 1);
    await firstDb.query(
      `UPDATE remote_agent_provider_slots SET lease_id = $3
       WHERE provider_id = $1 AND slot_index = $2`,
      ['pi', 0, 'newer-owner']
    );
    await successor.release();

    const rows = await secondDb.query<{ lease_id: string }>(
      `SELECT lease_id FROM remote_agent_provider_slots
       WHERE provider_id = $1 AND slot_index = $2`,
      ['pi', 0]
    );
    expect(rows.rows).toEqual([{ lease_id: 'newer-owner' }]);
  });

  test('stops waiting when the owning workflow becomes terminal', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const first = await gate(firstDb).acquire('pi', 1);
    let checks = 0;

    await expect(
      gate(secondDb).acquire('pi', 1, {
        shouldContinue: async () => ++checks < 2,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(checks).toBe(2);
    await first.release();
  });

  test('renews a live lease and aborts the owner when ownership is lost', async () => {
    const [db] = sharedDatabase();
    const renewableGate = new ProviderConcurrencyGate(db, {
      leaseMs: 1_000,
      heartbeatMs: 10,
      pollMs: 1,
    });
    const lease = await renewableGate.acquire('pi', 1);
    const initial = await db.query<{ lease_expires_at: string }>(
      `SELECT lease_expires_at FROM remote_agent_provider_slots
       WHERE provider_id = $1 AND slot_index = $2`,
      ['pi', 0]
    );
    const initialExpiry = initial.rows[0]?.lease_expires_at;

    let renewedExpiry = initialExpiry;
    for (let attempt = 0; attempt < 40 && renewedExpiry === initialExpiry; attempt += 1) {
      await Bun.sleep(5);
      const current = await db.query<{ lease_expires_at: string }>(
        `SELECT lease_expires_at FROM remote_agent_provider_slots
         WHERE provider_id = $1 AND slot_index = $2`,
        ['pi', 0]
      );
      renewedExpiry = current.rows[0]?.lease_expires_at;
    }
    expect(renewedExpiry).not.toBe(initialExpiry);

    await db.query(
      `UPDATE remote_agent_provider_slots SET lease_id = $3
       WHERE provider_id = $1 AND slot_index = $2`,
      ['pi', 0, 'successor-owner']
    );
    if (!lease.signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('lease loss was not observed')), 500);
        lease.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
      });
    }
    expect(lease.signal.aborted).toBe(true);
    await lease.release();

    const successor = await db.query<{ lease_id: string }>(
      `SELECT lease_id FROM remote_agent_provider_slots
       WHERE provider_id = $1 AND slot_index = $2`,
      ['pi', 0]
    );
    expect(successor.rows).toEqual([{ lease_id: 'successor-owner' }]);
  });
});
