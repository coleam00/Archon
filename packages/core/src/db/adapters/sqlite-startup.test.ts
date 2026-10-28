// @archon-test-isolated
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { SqliteAdapter, resourceSlotHoldersTable } from './sqlite';
import { isSqliteSchemaCurrent, sqliteStartupDigest } from './sqlite-schema-state';
import { prepareGet, prepareAll } from './sqlite-statements';

const trackTempRoot = trackTempRoots();
async function fixture(): Promise<string> {
  const path = join(trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-sqlite-startup-'))), 'db');
  await new SqliteAdapter(path).close();
  return path;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for opener')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function openChild(path: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const { SqliteAdapter } = await import(${JSON.stringify(join(import.meta.dir, 'sqlite.ts'))});
await new SqliteAdapter(${JSON.stringify(path)}).close();
console.log('opened');`,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, LOG_LEVEL: 'info', LOG_FORMAT: 'json' },
    }
  );
  const waiting = Promise.withResolvers<void>();
  const output = (async () => {
    let text = '';
    for await (const chunk of child.stdout) {
      text += new TextDecoder().decode(chunk);
      if (text.includes('db.sqlite_busy_waiting') && text.includes('open')) waiting.resolve();
    }
    return text;
  })();
  const result = Promise.all([child.exited, output, new Response(child.stderr).text()]);
  return {
    child,
    result,
    waitForBusy: () =>
      Promise.race([
        waiting.promise,
        result.then(() => {
          throw new Error('Opener exited before reporting busy');
        }),
      ]),
  };
}

test('current startup completes while another connection still owns the writer', async () => {
  const path = await fixture();
  const holder = new Database(path);
  holder.run('BEGIN IMMEDIATE');
  holder.run('UPDATE remote_agent_schema_version SET applied_at = applied_at WHERE id = 1');
  const before = state(holder);
  const opener = openChild(path);
  try {
    const [code, stdout, stderr] = await within(opener.result, 2000);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('opened');
    expect(holder.inTransaction).toBe(true);
    expect(state(holder)).toEqual(before);
  } finally {
    holder.run('ROLLBACK');
    holder.close();
    opener.child.kill();
    await opener.result;
  }
});

test('needed migration retries past the native timeout and concurrent openers converge', async () => {
  const path = await fixture();
  const holder = new Database(path);
  holder.run('DROP INDEX idx_workflow_events_order');
  holder.run('BEGIN IMMEDIATE');
  const openers = [openChild(path), openChild(path)];
  try {
    await within(Promise.all(openers.map(opener => opener.waitForBusy())), 12000);
    holder.run('COMMIT');
    let convergences = 0;
    for (const opener of openers) {
      const [code, stdout, stderr] = await within(opener.result, 5000);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(stdout).toContain('opened');
      convergences += stdout
        .split('\n')
        .filter(line => line.includes('db.sqlite_schema_initialized')).length;
    }
    expect(convergences).toBe(1);
    expect(
      prepareGet(holder, "SELECT name FROM sqlite_master WHERE name = 'idx_workflow_events_order'")
    ).not.toBeNull();
    await expectStableReopen(path, holder);
  } finally {
    if (holder.inTransaction) holder.run('ROLLBACK');
    holder.close();
    for (const opener of openers) opener.child.kill();
    await Promise.all(openers.map(opener => opener.result));
  }
}, 20000);

function state(db: Database) {
  return {
    cookie: prepareGet<{ schema_version: number }>(db, 'PRAGMA main.schema_version')
      ?.schema_version,
    marker: prepareGet<{ schema_fingerprint: string | null }>(
      db,
      'SELECT schema_fingerprint FROM remote_agent_schema_version WHERE id = 1'
    )?.schema_fingerprint,
    current: db.transaction(() => isSqliteSchemaCurrent(db, SqliteAdapter.schemaDigest)).deferred(),
  };
}

async function expectStableReopen(path: string, raw: Database): Promise<void> {
  const before = state(raw);
  expect(before.current).toBe(true);
  expect(before.marker).toStartWith('sqlite-v1:');
  await new SqliteAdapter(path).close();
  expect(state(raw)).toEqual(before);
}

test.each([
  ['dropped index', 'DROP INDEX idx_workflow_events_order'],
  [
    'replaced trigger',
    `DROP TRIGGER remote_agent_workflow_events_assign_order;
    CREATE TRIGGER remote_agent_workflow_events_assign_order AFTER INSERT ON remote_agent_workflow_events
    BEGIN SELECT 1; END`,
  ],
  [
    'missing metadata column',
    'ALTER TABLE remote_agent_schema_version DROP COLUMN schema_fingerprint',
  ],
  ['missing metadata row', 'DELETE FROM remote_agent_schema_version'],
  ['NULL metadata', 'UPDATE remote_agent_schema_version SET schema_fingerprint = NULL'],
  [
    'different build metadata',
    "UPDATE remote_agent_schema_version SET schema_fingerprint = 'other-build'",
  ],
])('repairs %s and publishes a stable completion proof', async (_name, damage) => {
  const path = await fixture();
  const raw = new Database(path);
  try {
    const originalTrigger = prepareGet<{ sql: string }>(
      raw,
      "SELECT sql FROM sqlite_master WHERE name = 'remote_agent_workflow_events_assign_order'"
    );
    raw.exec(damage);
    expect(
      raw.transaction(() => isSqliteSchemaCurrent(raw, SqliteAdapter.schemaDigest)).deferred()
    ).toBe(false);
    await new SqliteAdapter(path).close();
    expect(
      prepareGet<{ sql: string }>(
        raw,
        "SELECT sql FROM sqlite_master WHERE name = 'remote_agent_workflow_events_assign_order'"
      )
    ).toEqual(originalTrigger);
    expect(
      prepareGet(raw, "SELECT name FROM sqlite_master WHERE name = 'idx_workflow_events_order'")
    ).not.toBeNull();
    await expectStableReopen(path, raw);
  } finally {
    raw.close();
  }
});

test.each(['missing', 'behind'])(
  'repairs a %s sequence head without schema invalidation',
  async damage => {
    const path = await fixture();
    const raw = new Database(path);
    try {
      raw.exec(`INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ('c', 'test', 'c');
      INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message) VALUES ('r', 'c', 'w', '');
      INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ('first', 'r', 'workflow_started');`);
      const before = state(raw);
      raw.run(
        damage === 'missing'
          ? 'DELETE FROM remote_agent_workflow_event_sequence'
          : 'UPDATE remote_agent_workflow_event_sequence SET value = 0'
      );
      expect(state(raw).cookie).toBe(before.cookie);
      expect(state(raw).current).toBe(false);
      await new SqliteAdapter(path).close();
      raw.run(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ('second', 'r', 'workflow_started')"
      );
      expect(
        prepareGet<{ event_order: number }>(
          raw,
          "SELECT event_order FROM remote_agent_workflow_events WHERE id = 'second'"
        )
      ).toEqual({ event_order: 2 });
      raw.run('DELETE FROM remote_agent_workflow_events');
      await expectStableReopen(path, raw);
      raw.run(
        "INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type) VALUES ('third', 'r', 'workflow_started')"
      );
      expect(
        prepareGet<{ event_order: number }>(
          raw,
          "SELECT event_order FROM remote_agent_workflow_events WHERE id = 'third'"
        )
      ).toEqual({ event_order: 3 });
      await expectStableReopen(path, raw);
    } finally {
      raw.close();
    }
  }
);

test('incomplete tolerated work remains unstamped and is retried until repaired', async () => {
  const path = await fixture();
  const raw = new Database(path);
  try {
    raw.exec(`DROP TABLE remote_agent_users;
      CREATE TABLE users_backing (id TEXT PRIMARY KEY);
      CREATE VIEW remote_agent_users AS SELECT id FROM users_backing;`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await new SqliteAdapter(path).close();
      expect(state(raw).marker).toBeNull();
      expect(state(raw).current).toBe(false);
    }
    raw.run('DROP VIEW remote_agent_users');
    await new SqliteAdapter(path).close();
    await expectStableReopen(path, raw);
  } finally {
    raw.close();
  }
});

test('a required non-busy failure rolls back convergence and publishes no valid marker', async () => {
  const path = await fixture();
  const raw = new Database(path);
  try {
    raw.exec(`DROP INDEX idx_workflow_events_order;
      CREATE VIEW idx_workflow_events_order AS SELECT 1;
      ALTER TABLE remote_agent_users DROP COLUMN role;`);
    const before = state(raw);
    expect(() => new SqliteAdapter(path)).toThrow('idx_workflow_events_order');
    expect(state(raw)).toEqual(before);
    expect(before.current).toBe(false);
    expect(
      prepareAll<{ name: string }>(raw, 'PRAGMA table_info(remote_agent_users)').map(c => c.name)
    ).not.toContain('role');
    raw.run('DROP VIEW idx_workflow_events_order');
    await new SqliteAdapter(path).close();
    await expectStableReopen(path, raw);
  } finally {
    raw.close();
  }
});

test('older writers can omit nullable completion metadata', async () => {
  const path = await fixture();
  const raw = new Database(path);
  try {
    raw.run('DELETE FROM remote_agent_schema_version');
    raw.run("INSERT INTO remote_agent_schema_version (id, app_version) VALUES (1, 'old')");
    expect(state(raw).marker).toBeNull();
    await new SqliteAdapter(path).close();
    await expectStableReopen(path, raw);
  } finally {
    raw.close();
  }
});

test.each([
  [
    'diagnostic vintage',
    "UPDATE remote_agent_schema_version SET app_version = 'old'",
    'BEFORE UPDATE OF app_version',
  ],
  ['completion metadata', 'SELECT 1', 'BEFORE UPDATE OF schema_fingerprint'],
])('a failed %s write cannot publish completion', async (_name, seed, event) => {
  const path = await fixture();
  const raw = new Database(path);
  try {
    raw.run(seed);
    raw.run(`CREATE TRIGGER reject_metadata ${event} ON remote_agent_schema_version
      BEGIN SELECT RAISE(ABORT, 'metadata write refused'); END`);
    await new SqliteAdapter(path).close();
    expect(state(raw).current).toBe(false);
    raw.run('DROP TRIGGER reject_metadata');
    await new SqliteAdapter(path).close();
    await expectStableReopen(path, raw);
  } finally {
    raw.close();
  }
});

test('the startup digest ignores comments and layout but not DDL', () => {
  const digest = (step: (db: Database) => void) => sqliteStartupDigest([step]);
  const original = digest(db => {
    db.run(`
      CREATE TABLE t (id TEXT PRIMARY KEY);
    `);
  });
  const commented = digest(db => {
    // Why t exists.
    db.run(`
      -- One row per thing.
      CREATE TABLE t (
        id TEXT PRIMARY KEY
      );

    `);
  });
  const changed = digest(db => {
    db.run(`
      CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT);
    `);
  });
  expect(commented).toBe(original);
  expect(changed).not.toBe(original);
});

test("the adapter's digest covers the schema DDL and the slot holders table", () => {
  const createSchema = SqliteAdapter.prototype['createSchema'];
  for (const partial of [[], [resourceSlotHoldersTable], [createSchema]]) {
    expect(SqliteAdapter.schemaDigest).not.toBe(sqliteStartupDigest(partial));
  }
});
