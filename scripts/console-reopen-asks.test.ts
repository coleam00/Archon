import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { reopenAnsweredAsks } from './console-reopen-asks';

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

/** The asks table as the SQLite adapter creates it (`packages/core/src/db/adapters/sqlite.ts`). */
function asksTable(): Database {
  const memory = new Database(':memory:');
  memory.run(`CREATE TABLE remote_agent_item_asks (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    position INTEGER NOT NULL,
    ask TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_as TEXT,
    answer TEXT,
    closed_at TEXT,
    closed_via TEXT,
    closed_by_declared TEXT,
    closed_by_user_id TEXT,
    closed_from_run_id TEXT,
    closed_from_node_path TEXT,
    replaced_by_run_id TEXT
  )`);
  return memory;
}

function ask(
  memory: Database,
  id: string,
  item: string,
  run: string,
  at: string,
  closedAs: string | null
): void {
  memory.run(
    `INSERT INTO remote_agent_item_asks
       (id, item_id, run_id, workflow_name, position, ask, created_at, closed_as, answer, closed_at, closed_via)
     VALUES (?, ?, ?, 'deliver', 0, '{}', ?, ?, ?, ?, ?)`,
    [
      id,
      item,
      run,
      at,
      closedAs,
      closedAs === 'answered' ? '{"text":""}' : null,
      closedAs === null ? null : at,
      closedAs === null ? null : 'web',
    ]
  );
}

const open = (memory: Database): string[] =>
  memory
    .query<{ id: string }, []>(
      'SELECT id FROM remote_agent_item_asks WHERE closed_as IS NULL ORDER BY id'
    )
    .all()
    .map(row => row.id);

test('reopens the newest answered set per item and workflow, once, leaving older and mixed sets closed', () => {
  db = asksTable();
  // Item A: an older answered set, then a newer one of two asks.
  ask(db, 'a-old', 'A', 'run-a1', '2026-11-10T00:00:00Z', 'answered');
  ask(db, 'a-new-1', 'A', 'run-a2', '2026-11-12T00:00:00Z', 'answered');
  ask(db, 'a-new-2', 'A', 'run-a2', '2026-11-12T00:00:00Z', 'answered');
  // Item B: its newest set had an ask withdrawn, so it is not reopened, nor is the older one.
  ask(db, 'b-old', 'B', 'run-b1', '2026-11-10T00:00:00Z', 'answered');
  ask(db, 'b-new-1', 'B', 'run-b2', '2026-11-12T00:00:00Z', 'answered');
  ask(db, 'b-new-2', 'B', 'run-b2', '2026-11-12T00:00:00Z', 'withdrawn');
  // Item C: already open.
  ask(db, 'c-open', 'C', 'run-c1', '2026-11-12T00:00:00Z', null);

  expect(reopenAnsweredAsks(db)).toBe(2);
  expect(open(db)).toEqual(['a-new-1', 'a-new-2', 'c-open']);
  const row = db
    .query<Record<string, unknown>, []>("SELECT * FROM remote_agent_item_asks WHERE id = 'a-new-1'")
    .get();
  expect(row).toMatchObject({ closed_as: null, answer: null, closed_at: null, closed_via: null });

  // A second run finds every newest set open or mixed: nothing changes.
  expect(reopenAnsweredAsks(db)).toBe(0);
  expect(open(db)).toEqual(['a-new-1', 'a-new-2', 'c-open']);
});
