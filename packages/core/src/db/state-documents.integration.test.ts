// @archon-test-isolated
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  assertPatchSurvivesInterleavedWrites,
  assertStateProcessRaces,
} from './state-documents.process-contract';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, removeTempTree } from '@archon/paths/test-utils';
import { describeStateDocumentConformance } from '@archon/workflows/state-document-conformance';
import { stateScopeKey } from '@archon/workflows/state-document-store';
import { SqliteAdapter } from './adapters/sqlite';
import { createSqlStateDocumentStore } from './state-documents';

const track = trackTempRoots();
describeStateDocumentConformance('SQLite', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-documents-')));
  const db = new SqliteAdapter(join(root, 'state.db'));
  return {
    store: createSqlStateDocumentStore(() => db),
    backdate: async (scope, name) => {
      await db.query(
        'UPDATE remote_agent_state_revisions SET created_at = $3 WHERE project_key = $1 AND name = $2',
        [stateScopeKey(scope), name, '2000-01-01T00:00:00.000Z']
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

test('a patch survives a write committed after each of its reads', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-interleave-')));
  const db = new SqliteAdapter(join(root, 'state.db'));
  const other = new SqliteAdapter(join(root, 'state.db'));
  try {
    await assertPatchSurvivesInterleavedWrites(db, other);
  } finally {
    await other.close();
    await db.close();
    await removeTempTree(root);
  }
}, 30_000);

test('a pre-writer_via database gains the column and reads CLI-era rows as the CLI surface', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'state-upgrade-')));
  const address = join(root, 'state.db');
  // The table as #3981 created it, holding one revision an operator wrote.
  const legacy = new Database(address);
  legacy.run(`CREATE TABLE remote_agent_state_revisions (
    project_key TEXT NOT NULL, name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1), value TEXT, operation TEXT NOT NULL,
    writer_kind TEXT NOT NULL CHECK (writer_kind IN ('run', 'operator')),
    writer_run_id TEXT, writer_node_path TEXT, writer_identity TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_key, name, revision))`);
  legacy.run(
    `INSERT INTO remote_agent_state_revisions (project_key, name, revision, value, operation, writer_kind, writer_identity)
     VALUES ('owner/repo', 'ledger', 1, '{"a":1}', '{"op":"put"}', 'operator', 'rasmus')`
  );
  legacy.close();
  const db = new SqliteAdapter(address);
  try {
    const store = createSqlStateDocumentStore(() => db);
    const scope = { kind: 'project', key: 'owner/repo' } as const;
    expect((await store.getStateDocument(scope, 'ledger'))?.writer).toEqual({
      kind: 'surface',
      via: 'cli',
    });
    const next = await store.patchStateDocument({
      scope,
      name: 'ledger',
      ops: [{ op: 'set', path: '/b', value: 2 }],
      writer: { kind: 'surface', via: 'api' },
    });
    expect((await store.listStateRevisions(scope, 'ledger'))[0]).toEqual(next);
    expect(next.writer).toEqual({ kind: 'surface', via: 'api' });
  } finally {
    await db.close();
    await removeTempTree(root);
  }
});
