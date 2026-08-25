import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IDatabase } from './adapters/types';
import { SqliteAdapter } from './adapters/sqlite';
import { ProviderConcurrencyGate } from './provider-concurrency';
import { mockPostgresDialect } from '../test/mocks/database';

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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for fixture marker: ${path}`);
    await Bun.sleep(5);
  }
}

afterEach(async () => {
  for (const db of openDatabases.splice(0)) await db.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
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

  test('coordinates a cap across independent processes sharing SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-provider-concurrency-process-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'archon.db');
    const fixture = join(import.meta.dir, 'provider-concurrency.fixture.ts');
    const holder = Bun.spawn([process.execPath, fixture, databasePath, 'holder', dir], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    let waiter: ReturnType<typeof Bun.spawn> | undefined;

    try {
      await waitForFile(join(dir, 'holder-acquired'));
      waiter = Bun.spawn([process.execPath, fixture, databasePath, 'waiter', dir], {
        stdout: 'ignore',
        stderr: 'pipe',
      });
      await waitForFile(join(dir, 'waiter-queued'));
      expect(existsSync(join(dir, 'waiter-acquired'))).toBe(false);

      writeFileSync(join(dir, 'release-holder'), '');
      await waitForFile(join(dir, 'waiter-acquired'));
      expect(await holder.exited).toBe(0);
      expect(await waiter.exited).toBe(0);
    } finally {
      holder.kill();
      waiter?.kill();
      await Promise.allSettled([holder.exited, ...(waiter ? [waiter.exited] : [])]);
    }
  }, 15_000);

  test('reclaims a real process lease after the owner dies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-provider-concurrency-crash-'));
    tempDirs.push(dir);
    const databasePath = join(dir, 'archon.db');
    const fixture = join(import.meta.dir, 'provider-concurrency.fixture.ts');
    const holder = Bun.spawn([process.execPath, fixture, databasePath, 'holder', dir, '250'], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    let waiter: ReturnType<typeof Bun.spawn> | undefined;

    try {
      await waitForFile(join(dir, 'holder-acquired'));
      waiter = Bun.spawn([process.execPath, fixture, databasePath, 'waiter', dir, '250'], {
        stdout: 'ignore',
        stderr: 'pipe',
      });
      await waitForFile(join(dir, 'waiter-queued'));

      holder.kill();
      await holder.exited;
      await waitForFile(join(dir, 'waiter-acquired'));
      expect(await waiter.exited).toBe(0);
    } finally {
      holder.kill();
      waiter?.kill();
      await Promise.allSettled([holder.exited, ...(waiter ? [waiter.exited] : [])]);
    }
  }, 15_000);

  test('different providers use independent slot pools', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const pi = await gate(firstDb).acquire('pi', 1);
    const claude = await gate(secondDb).acquire('claude', 1);

    expect(pi.slot).toBe(0);
    expect(claude.slot).toBe(0);
    await pi.release();
    await claude.release();
  });

  test('admits exactly the configured number of concurrent owners', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const first = await gate(firstDb).acquire('pi', 2);
    const second = await gate(secondDb).acquire('pi', 2);
    expect(new Set([first.slot, second.slot])).toEqual(new Set([0, 1]));

    let thirdAdmitted = false;
    const thirdPromise = gate(firstDb)
      .acquire('pi', 2)
      .then(lease => {
        thirdAdmitted = true;
        return lease;
      });
    await Bun.sleep(5);
    expect(thirdAdmitted).toBe(false);

    await first.release();
    const third = await thirdPromise;
    expect(third.slot).toBe(first.slot);
    await second.release();
    await third.release();
  });

  test('counts live slots outside a reduced limit before admitting new work', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const original = await Promise.all([
      gate(firstDb).acquire('pi', 4),
      gate(firstDb).acquire('pi', 4),
      gate(firstDb).acquire('pi', 4),
      gate(firstDb).acquire('pi', 4),
    ]);
    const bySlot = original.toSorted((a, b) => a.slot - b.slot);
    await bySlot[0]?.release();
    await bySlot[1]?.release();

    let queued = false;
    const reduced = gate(secondDb).acquire('pi', 2, {
      observer: {
        onQueued: () => {
          queued = true;
        },
      },
    });
    while (!queued) await Bun.sleep(1);

    const liveBefore = await firstDb.query(
      `SELECT slot_index FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(liveBefore.rowCount).toBe(2);

    await bySlot[2]?.release();
    const admitted = await reduced;
    expect(admitted.slot).toBe(0);

    await bySlot[3]?.release();
    await admitted.release();
  });

  test('aborts a queued waiter without disturbing the live owner', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const first = await gate(firstDb).acquire('pi', 1);
    const controller = new AbortController();
    let queued = false;
    let dequeued = false;
    const waiter = gate(secondDb).acquire('pi', 1, {
      signal: controller.signal,
      observer: {
        onQueued: () => {
          queued = true;
        },
        onDequeued: () => {
          dequeued = true;
        },
      },
    });

    while (!queued) await Bun.sleep(1);
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
    expect(dequeued).toBe(true);

    const rows = await firstDb.query<{ lease_id: string }>(
      `SELECT lease_id FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(rows.rowCount).toBe(1);
    await first.release();
  });

  test('releases a successful claim when cancellation wins during the claim query', async () => {
    const [db] = sharedDatabase();
    const controller = new AbortController();
    const cancellingDb: IDatabase = {
      dialect: db.dialect,
      sql: db.sql,
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await db.query<T>(sql, params);
        if (sql.includes('INSERT INTO remote_agent_provider_slots')) controller.abort();
        return result;
      },
      withTransaction: callback => db.withTransaction(callback),
      close: () => db.close(),
    };

    const cancellingGate = new ProviderConcurrencyGate(cancellingDb, {
      leaseMs: 10_000,
      heartbeatMs: 2_000,
      pollMs: 1,
    });
    await expect(
      cancellingGate.acquire('pi', 1, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    const rows = await db.query(
      `SELECT lease_id FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(rows.rowCount).toBe(0);
  });

  test('releases a successful claim when its workflow becomes terminal during the query', async () => {
    const [db] = sharedDatabase();
    let checks = 0;
    await expect(
      gate(db).acquire('pi', 1, {
        shouldContinue: async () => ++checks === 1,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(checks).toBe(2);
    const rows = await db.query(
      `SELECT lease_id FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(rows.rowCount).toBe(0);
  });

  test('does not let an unknown lifecycle read authorize a claim', async () => {
    const [db] = sharedDatabase();
    let checks = 0;

    await expect(
      gate(db).acquire('pi', 1, {
        shouldContinue: async () => (++checks === 1 ? undefined : false),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(checks).toBe(2);
    const rows = await db.query(
      `SELECT lease_id FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(rows.rowCount).toBe(0);
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

  test('observer failures and unsettled callbacks cannot hold capacity', async () => {
    const [firstDb, secondDb] = sharedDatabase();
    const first = await gate(firstDb).acquire('pi', 1);
    let queued = false;
    const never = new Promise<void>(() => undefined);
    const secondPromise = gate(secondDb).acquire('pi', 1, {
      observer: {
        onQueued: () => {
          queued = true;
          return never;
        },
        onWaiting: () => {
          throw new Error('observer failed');
        },
        onAcquired: () => never,
      },
    });

    while (!queued) await Bun.sleep(1);
    await first.release();
    const second = await secondPromise;
    expect(second.slot).toBe(0);
    await second.release();
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

  test('aborts before local expiry when a renewal query never returns', async () => {
    const [db] = sharedDatabase();
    let blockRenewal = false;
    const blockedDb: IDatabase = {
      dialect: db.dialect,
      sql: db.sql,
      query: async <T>(sql: string, params?: unknown[]) => {
        if (blockRenewal && sql.includes('UPDATE remote_agent_provider_slots')) {
          return await new Promise<never>(() => undefined);
        }
        return await db.query<T>(sql, params);
      },
      withTransaction: callback => db.withTransaction(callback),
      close: () => db.close(),
    };
    const guardedGate = new ProviderConcurrencyGate(blockedDb, {
      leaseMs: 80,
      heartbeatMs: 20,
      pollMs: 1,
    });
    const lease = await guardedGate.acquire('pi', 1);
    blockRenewal = true;

    if (!lease.signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('local expiry guard did not fire')), 150);
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
    expect(lease.signal.reason).toMatchObject({ name: 'AbortError' });
    await lease.release();
  });

  test('does not start with a claim response that consumed the renewal safety window', async () => {
    const [db] = sharedDatabase();
    let localNow = 0;
    const delayedDb: IDatabase = {
      dialect: db.dialect,
      sql: db.sql,
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await db.query<T>(sql, params);
        if (sql.includes('INSERT INTO remote_agent_provider_slots')) localNow = 70;
        return result;
      },
      withTransaction: callback => db.withTransaction(callback),
      close: () => db.close(),
    };
    const guardedGate = new ProviderConcurrencyGate(delayedDb, {
      leaseMs: 80,
      heartbeatMs: 20,
      pollMs: 1,
      now: () => localNow,
    });

    await expect(guardedGate.acquire('pi', 1)).rejects.toMatchObject({ name: 'AbortError' });
    const rows = await db.query(
      `SELECT lease_id FROM remote_agent_provider_slots WHERE provider_id = $1`,
      ['pi']
    );
    expect(rows.rowCount).toBe(0);
  });

  test('uses PostgreSQL server time for claim and renewal ownership checks', async () => {
    const queries: string[] = [];
    const db: IDatabase = {
      dialect: 'postgres',
      sql: mockPostgresDialect,
      query: async <T>(sql: string) => {
        queries.push(sql);
        return { rows: [] as T[], rowCount: sql.includes('DELETE') ? 0 : 1 };
      },
      withTransaction: async callback => callback(db.query.bind(db)),
      close: async () => undefined,
    };
    const postgresGate = new ProviderConcurrencyGate(db, {
      leaseMs: 100,
      heartbeatMs: 10,
      pollMs: 1,
    });
    const lease = await postgresGate.acquire('pi', 1);

    for (
      let attempt = 0;
      attempt < 20 && !queries.some(sql => sql.trimStart().startsWith('UPDATE'));
      attempt++
    ) {
      await Bun.sleep(2);
    }
    await lease.release();

    const claim = queries.find(sql => sql.includes('INSERT'));
    const renewal = queries.find(sql => sql.trimStart().startsWith('UPDATE'));
    expect(claim).toContain("NOW() + ($4 * INTERVAL '1 millisecond')");
    expect(claim).toContain('lease_expires_at <= NOW()');
    expect(renewal).toContain("NOW() + ($4 * INTERVAL '1 millisecond')");
    expect(renewal).toContain('lease_id = $3');
  });
});
