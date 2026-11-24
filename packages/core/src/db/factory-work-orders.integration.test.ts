// @archon-test-isolated
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';
import { describeFactoryWorkOrderReadConformance } from './factory-work-orders.conformance';
import { makeSqlConformanceHarness } from './workflow-store.conformance-harness';

const trackTempRoot = trackTempRoots();

describeFactoryWorkOrderReadConformance(async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'factory-work-orders-')));
  const db = new SqliteAdapter(join(root, 'store.db'));
  const close = async () => {
    await db.close();
    await removeTempTree(root);
  };
  try {
    const harness = await makeSqlConformanceHarness(db, sqliteDialect, 'sqlite', close);
    return { ...harness, db };
  } catch (error) {
    await close();
    throw error;
  }
});
