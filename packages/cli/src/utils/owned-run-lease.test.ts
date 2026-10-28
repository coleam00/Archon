import { expect, test } from 'bun:test';
import { requestRunLiveOwnerStop } from '@archon/core/services/run-live-owner';
import { OwnedRunLease } from './owned-run-lease';

for (const setupAlreadyStarted of [true, false]) {
  test(`forwards termination preparation with an existing setup owner: ${String(setupAlreadyStarted)}`, async () => {
    const lease = new OwnedRunLease(true);
    const runId = `owned-lease-${crypto.randomUUID()}`;
    if (setupAlreadyStarted) await lease.start(runId);
    const prepare = () => ({
      groups: [],
      ready: Promise.resolve(['fixture warning']),
      release: () => undefined,
    });
    const unregister = lease.registerTerminationPreparation(prepare);
    if (!setupAlreadyStarted) await lease.start(runId);
    const controller = await requestRunLiveOwnerStop(runId);
    try {
      expect(await controller.commit()).toEqual({ groups: [], warnings: ['fixture warning'] });
      unregister();
      const removeReplacement = lease.registerTerminationPreparation(() => ({
        groups: [],
        ready: Promise.resolve([]),
        release: () => undefined,
      }));
      unregister();
      const second = await requestRunLiveOwnerStop(runId);
      try {
        expect(await second.commit()).toEqual({ groups: [], warnings: [] });
      } finally {
        second.release();
        removeReplacement();
      }
    } finally {
      controller.release();
      unregister();
      await lease.close();
    }
  });
}
