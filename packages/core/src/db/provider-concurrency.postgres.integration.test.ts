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
      const timing = { leaseMs: 1_000, heartbeatMs: 150, pollMs: 5 };
      let firstLease: Awaited<ReturnType<ProviderConcurrencyGate['acquire']>> | undefined;
      let secondLease: Awaited<ReturnType<ProviderConcurrencyGate['acquire']>> | undefined;

      try {
        firstLease = await new ProviderConcurrencyGate(firstDb, timing).acquire(provider, 1);
        const initialExpiry = await firstDb.query<{ expires_ms: string }>(
          `SELECT (EXTRACT(EPOCH FROM lease_expires_at) * 1000)::text AS expires_ms
           FROM remote_agent_provider_slots
           WHERE provider_id = $1 AND slot_index = $2`,
          [provider, firstLease.slot]
        );

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

        await Bun.sleep(timing.leaseMs + timing.heartbeatMs);
        const renewed = await firstDb.query<{ expires_ms: string; expired: boolean }>(
          `SELECT
             (EXTRACT(EPOCH FROM lease_expires_at) * 1000)::text AS expires_ms,
             lease_expires_at <= NOW() AS expired
           FROM remote_agent_provider_slots
           WHERE provider_id = $1 AND slot_index = $2`,
          [provider, firstLease.slot]
        );
        expect(Number(renewed.rows[0]?.expires_ms)).toBeGreaterThan(
          Number(initialExpiry.rows[0]?.expires_ms)
        );
        expect(renewed.rows[0]?.expired).toBe(false);
        expect(firstLease.signal.aborted).toBe(false);
        expect(admitted).toBe(false);

        await firstLease.release({ upstreamStopped: true });
        firstLease = undefined;
        secondLease = await secondPromise;
        expect(admitted).toBe(true);
        expect(secondLease.slot).toBe(0);
      } finally {
        await firstLease?.release({ upstreamStopped: true });
        await secondLease?.release({ upstreamStopped: true });
        await firstDb.query('DELETE FROM remote_agent_provider_slots WHERE provider_id = $1', [
          provider,
        ]);
        await Promise.all([firstDb.close(), secondDb.close()]);
      }
    }, 20_000);
  }
);
