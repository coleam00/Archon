// @archon-test-isolated
import {
  assertPatchSurvivesInterleavedWrites,
  assertStateProcessRaces,
} from './state-documents.process-contract';
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describeStateDocumentConformance } from '@archon/workflows/state-document-conformance';
import { stateScopeKey, type StateScope } from '@archon/workflows/state-document-store';
import { PostgresAdapter } from './adapters/postgres';
import { createSqlStateDocumentStore } from './state-documents';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
describe.skipIf(!baseUrl)('scratch PostgreSQL state documents', () => {
  let admin: Pool;
  beforeAll(() => {
    admin = new Pool({ connectionString: baseUrl });
  });
  afterAll(async () => {
    await admin?.end();
  });
  const makeHarness = async () => {
    const name = `archon_state_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(baseUrl!);
    url.pathname = `/${name}`;
    const db = new PostgresAdapter(url.toString());
    return {
      db,
      url: url.toString(),
      store: createSqlStateDocumentStore(() => db),
      backdate: async (scope: StateScope, document: string): Promise<void> => {
        await db.query(
          'UPDATE remote_agent_state_revisions SET created_at = $3 WHERE project_key = $1 AND name = $2',
          [stateScopeKey(scope), document, '2000-01-01T00:00:00.000Z']
        );
      },
      close: async () => {
        try {
          await db.close();
        } finally {
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        }
      },
    };
  };
  describeStateDocumentConformance('PostgreSQL', makeHarness);
  test('eight separate PostgreSQL processes retain every patch and have one CAS winner', async () => {
    const harness = await makeHarness();
    try {
      await assertStateProcessRaces(harness.db, { kind: 'postgres', address: harness.url });
    } finally {
      await harness.close();
    }
  });
  test('a patch survives a write committed after each of its reads', async () => {
    const harness = await makeHarness();
    const other = new PostgresAdapter(harness.url);
    try {
      await assertPatchSurvivesInterleavedWrites(harness.db, other);
    } finally {
      await other.close();
      await harness.close();
    }
  });
});
