import { afterAll, beforeAll, describe } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describeWorkflowStoreConformance } from '@archon/workflows/store-conformance';
import { makeSqlConformanceHarness } from './workflow-store.conformance-harness';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
describe.skipIf(!baseUrl)('scratch PostgreSQL', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: baseUrl });
  });
  afterAll(async () => {
    await admin?.end();
  });
  describeWorkflowStoreConformance('PostgreSQL', async () => {
    const name = `archon_conformance_${randomUUID().replaceAll('-', '')}`;
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
      return await makeSqlConformanceHarness(db, postgresDialect, 'postgresql', close);
    } catch (error) {
      await close();
      throw error;
    }
  });
});
