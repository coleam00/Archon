// @archon-test-isolated
import { afterAll, beforeAll, describe } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';
import { describeFactoryWorkOrderReadConformance } from './factory-work-orders.conformance';
import { makeSqlConformanceHarness } from './workflow-store.conformance-harness';

// A scratch database per test on the server ARCHON_TEST_PG_URL names, created and dropped
// here (CI's postgres job runs every test file that reads ARCHON_TEST_PG_URL).
const baseUrl = process.env.ARCHON_TEST_PG_URL;
describe.skipIf(!baseUrl)('factory work orders on scratch PostgreSQL', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: baseUrl });
  });
  afterAll(async () => {
    await admin?.end();
  });
  describeFactoryWorkOrderReadConformance(async () => {
    const name = `archon_factory_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${name}`;
    const db = new PostgresAdapter(url.toString());
    const close = async () => {
      try {
        await db.close();
      } finally {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
    };
    try {
      const harness = await makeSqlConformanceHarness(db, postgresDialect, 'postgresql', close);
      return { ...harness, db };
    } catch (error) {
      await close();
      throw error;
    }
  });
});
