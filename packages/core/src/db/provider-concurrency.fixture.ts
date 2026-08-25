import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteAdapter } from './adapters/sqlite';
import { ProviderConcurrencyGate } from './provider-concurrency';

const [databasePath, mode, markerDirectory, leaseMsArg] = process.argv.slice(2);
if (!databasePath || !mode || !markerDirectory) {
  throw new Error('Expected database path, mode, and marker directory');
}

const db = new SqliteAdapter(databasePath);
const leaseMs = leaseMsArg ? Number(leaseMsArg) : 120_000;
const gate = new ProviderConcurrencyGate(db, {
  leaseMs,
  heartbeatMs: Math.max(10, Math.floor(leaseMs / 4)),
  pollMs: 5,
});

try {
  if (mode === 'holder') {
    const lease = await gate.acquire('pi', 1);
    writeFileSync(join(markerDirectory, 'holder-acquired'), '');
    while (!existsSync(join(markerDirectory, 'release-holder'))) await Bun.sleep(5);
    await lease.release();
  } else if (mode === 'waiter') {
    const lease = await gate.acquire('pi', 1, {
      observer: {
        onQueued: () => {
          writeFileSync(join(markerDirectory, 'waiter-queued'), '');
        },
      },
    });
    writeFileSync(join(markerDirectory, 'waiter-acquired'), '');
    await lease.release();
  } else {
    throw new Error(`Unknown fixture mode '${mode}'`);
  }
} finally {
  await db.close();
}
