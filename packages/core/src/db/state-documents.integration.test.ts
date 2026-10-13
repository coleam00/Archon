// @archon-test-isolated
import { test } from 'bun:test';
import { assertStateProcessRaces } from './state-documents.process-contract';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, removeTempTree } from '@archon/paths/test-utils';
import { describeStateDocumentConformance } from '@archon/workflows/state-document-conformance';
import { SqliteAdapter } from './adapters/sqlite';
import { createSqlStateDocumentStore } from './state-documents';

const track = trackTempRoots();
describeStateDocumentConformance('SQLite', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-documents-')));
  const db = new SqliteAdapter(join(root, 'state.db'));
  return {
    store: createSqlStateDocumentStore(db),
    backdate: async (project, name) => {
      await db.query(
        'UPDATE remote_agent_state_revisions SET created_at = $3 WHERE project_key = $1 AND name = $2',
        [project, name, '2000-01-01T00:00:00.000Z']
      );
    },
    close: async () => {
      await db.close();
      await removeTempTree(root);
    },
  };
});

test('eight separate SQLite processes retain every patch and have one CAS winner', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-process-')));
  const address = join(root, 'state.db');
  const db = new SqliteAdapter(address);
  try {
    await assertStateProcessRaces(db, { kind: 'sqlite', address });
  } finally {
    await db.close();
    await removeTempTree(root);
  }
});
