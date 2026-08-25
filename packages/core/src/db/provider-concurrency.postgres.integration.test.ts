import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PostgresAdapter } from './adapters/postgres';
import { ProviderConcurrencyGate } from './provider-concurrency';

function postgresUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST ?? 'localhost';
  const port = process.env.PGPORT ?? '5432';
  const user = process.env.PGUSER ?? 'postgres';
  const password = process.env.PGPASSWORD ?? 'postgres';
  const database = process.env.PGDATABASE ?? user;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

describe.skipIf(process.env.ARCHON_POSTGRES_INTEGRATION !== 'true')(
  'ProviderConcurrencyGate PostgreSQL integration',
  () => {
    test('serializes contending claims and transfers the slot after release', async () => {
      const firstDb = new PostgresAdapter(postgresUrl());
      await firstDb.query('SELECT 1');
      const secondDb = new PostgresAdapter(postgresUrl());
      await secondDb.query('SELECT 1');
      const provider = `integration-${randomUUID()}`;
      const timing = { leaseMs: 10_000, heartbeatMs: 2_000, pollMs: 5 };
      let firstLease: Awaited<ReturnType<ProviderConcurrencyGate['acquire']>> | undefined;
      let secondLease: Awaited<ReturnType<ProviderConcurrencyGate['acquire']>> | undefined;

      try {
        firstLease = await new ProviderConcurrencyGate(firstDb, timing).acquire(provider, 1);

        let queued = false;
        let admitted = false;
        const secondPromise = new ProviderConcurrencyGate(secondDb, timing)
          .acquire(provider, 1, {
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
        const held = await firstDb.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
         FROM remote_agent_provider_slots
         WHERE provider_id = $1 AND lease_expires_at > NOW()`,
          [provider]
        );
        expect(held.rows[0]?.count).toBe('1');

        await firstLease.release();
        firstLease = undefined;
        secondLease = await secondPromise;
        expect(admitted).toBe(true);
        expect(secondLease.slot).toBe(0);
      } finally {
        await firstLease?.release();
        await secondLease?.release();
        await firstDb.query('DELETE FROM remote_agent_provider_slots WHERE provider_id = $1', [
          provider,
        ]);
        await Promise.all([firstDb.close(), secondDb.close()]);
      }
    }, 20_000);
  }
);
