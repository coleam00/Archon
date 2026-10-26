import { afterEach, describe, expect, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from '../sqlite';
import { Database, type Statement } from 'bun:sqlite';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { raw_query } from '../sqlite-test-harness';
import { resolve } from 'node:path';
import type { setupSqliteTests } from './sqlite-fixtures';

export function registerFinalizationTests(shared: ReturnType<typeof setupSqliteTests>) {
  describe('SqliteAdapter native-resource finalization (#2875)', () => {
    let adapter: SqliteAdapter | undefined;

    afterEach(async () => {
      if (adapter) {
        await adapter.close();
        adapter = undefined;
      }
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(shared.currentDbPath + suffix);
        } catch {
          /* may not exist */
        }
      }
    });

    test('finalizes every statement it prepares by the time close() resolves', async () => {
      const originalPrepare = Database.prototype.prepare;
      let prepared = 0;
      let finalized = 0;
      Object.defineProperty(Database.prototype, 'prepare', {
        configurable: true,
        value(this: Database, ...args: Parameters<typeof originalPrepare>) {
          const stmt: Statement = originalPrepare.apply(this, args);
          prepared++;
          const nativeFinalize = stmt.finalize.bind(stmt);
          stmt.finalize = () => {
            finalized++;
            return nativeFinalize();
          };
          return stmt;
        },
      });

      try {
        adapter = shared.createTestDb();
        await shared.insertCodebase(adapter, 'cb-finalize');
        await adapter.query('SELECT id FROM remote_agent_codebases WHERE id = $1', ['cb-finalize']);

        // A statement that prepares cleanly but fails on execution (primary key
        // violation) must still be finalized (this is the finally-branch of the fix).
        await expect(shared.insertCodebase(adapter, 'cb-finalize')).rejects.toThrow();

        await adapter.close();
        adapter = undefined;

        expect(prepared).toBeGreaterThan(0);
        expect(finalized).toBe(prepared);
      } finally {
        Object.defineProperty(Database.prototype, 'prepare', {
          configurable: true,
          value: originalPrepare,
        });
      }
    });

    test('close() leaves the database file immediately deletable', async () => {
      adapter = shared.createTestDb();
      await shared.insertCodebase(adapter, 'cb-delete');
      await adapter.query('SELECT id FROM remote_agent_codebases WHERE id = $1', ['cb-delete']);
      await adapter.close();
      adapter = undefined;

      // Passes trivially where POSIX unlink tolerates open handles, but on
      // windows-latest this fails with EBUSY while any statement is unfinalized.
      unlinkSync(shared.currentDbPath);
    });
  });
}

export function registerBusyLocksTests(shared: ReturnType<typeof setupSqliteTests>) {
  describe('SqliteAdapter busy locks', () => {
    let adapter: SqliteAdapter;
    let holder: Database;

    async function lockedAdapter(): Promise<string> {
      const root = shared.trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-sqlite-busy-')));
      const path = join(root, 'archon.db');
      adapter = new SqliteAdapter(path);
      // The adapter's own 5 s busy_timeout would make these tests slow, not different.
      await adapter.query('PRAGMA busy_timeout = 20');
      holder = new Database(path);
      holder.run('BEGIN IMMEDIATE');
      return path;
    }

    afterEach(async () => {
      if (holder.inTransaction) holder.run('ROLLBACK');
      holder.close();
      await adapter.close();
    });

    /**
     * Settle `promise` and return its rejection message. On Windows, Bun's
     * `expect(promise).rejects` on a promise still waiting on a timer started inside
     * AsyncLocalStorage.run (the adapter's transaction scope) blocks the event loop, so
     * the timer never fires and the test hangs past its own timeout.
     */
    async function rejectionMessage(promise: Promise<unknown>): Promise<string | undefined> {
      try {
        await promise;
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    }

    async function codebaseCount(): Promise<number> {
      const result = await adapter.query<{ cnt: number }>(
        'SELECT COUNT(*) AS cnt FROM remote_agent_codebases'
      );
      return Number(result.rows[0]?.cnt);
    }

    test('a statement waits past busy_timeout and writes once', async () => {
      await lockedAdapter();
      // Several 20 ms busy timeouts elapse before the holder lets go.
      const released = Bun.sleep(150).then(() => holder.run('COMMIT'));

      await shared.insertCodebase(adapter, 'cb-busy');
      await released;

      expect(await codebaseCount()).toBe(1);
    });

    test('a transaction rolls back and reruns from BEGIN until the lock clears', async () => {
      await lockedAdapter();
      const released = Bun.sleep(150).then(() => holder.run('COMMIT'));
      let attempts = 0;

      await adapter.withTransaction(async query => {
        attempts++;
        await query(
          `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
          ['cb-tx', 'cb-tx', '/tmp/test-cwd']
        );
      });
      await released;

      expect(attempts).toBeGreaterThan(1);
      expect(await codebaseCount()).toBe(1);
    });

    test('a block that wraps the busy error in its own still reruns from BEGIN', async () => {
      await lockedAdapter();
      const released = Bun.sleep(150).then(() => holder.run('COMMIT'));
      let attempts = 0;

      await adapter.withTransaction(async query => {
        attempts++;
        try {
          await query(
            `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
            ['cb-wrapped', 'cb-wrapped', '/tmp/test-cwd']
          );
        } catch (error) {
          throw new Error(`Failed to create codebase: ${(error as Error).message}`);
        }
      });
      await released;

      expect(attempts).toBeGreaterThan(1);
      expect(await codebaseCount()).toBe(1);
    });

    test('a stale snapshot reruns the transaction instead of retrying the statement', async () => {
      await lockedAdapter();
      holder.run(
        "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('cb-holder', 'cb-holder', '/tmp')"
      );
      const seen: number[] = [];

      await adapter.withTransaction(async query => {
        const before = await query<{ cnt: number }>(
          'SELECT COUNT(*) AS cnt FROM remote_agent_codebases'
        );
        seen.push(Number(before.rows[0]?.cnt));
        // The holder commits after this transaction took its read snapshot, so the
        // first write fails with SQLITE_BUSY_SNAPSHOT however long it waits.
        if (holder.inTransaction) holder.run('COMMIT');
        await query(
          `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
          ['cb-snapshot', 'cb-snapshot', '/tmp/test-cwd']
        );
      });

      expect(seen).toEqual([0, 1]);
      expect(await codebaseCount()).toBe(2);
    });

    test("a waiting statement does not retry into another caller's transaction", async () => {
      await lockedAdapter();
      const released = Bun.sleep(100).then(() => holder.run('COMMIT'));

      const statement = shared.insertCodebase(adapter, 'cb-outside');
      // Let the statement fail busy once and start its backoff sleep.
      await Bun.sleep(30);
      // A transaction that stays open past the statement's retry, then rolls back.
      const transaction = adapter.withTransaction(async query => {
        await query('SELECT 1');
        await Bun.sleep(300);
        throw new Error('abort');
      });

      await statement;
      expect(await rejectionMessage(transaction)).toBe('abort');
      await released;

      expect(await codebaseCount()).toBe(1);
    });

    test("a plain statement never runs inside another caller's open transaction", async () => {
      await lockedAdapter();
      holder.run('COMMIT');

      const transaction = adapter.withTransaction(async query => {
        await query('SELECT 1');
        await Bun.sleep(100);
        throw new Error('abort');
      });
      // Issued while the transaction is open and waiting on something else.
      await Bun.sleep(20);
      const statement = shared.insertCodebase(adapter, 'cb-plain');

      expect(await rejectionMessage(transaction)).toBe('abort');
      await statement;

      expect(await codebaseCount()).toBe(1);
    });

    test('the public query inside a transaction block fails instead of waiting on itself', async () => {
      await lockedAdapter();
      holder.run('COMMIT');

      await expect(
        adapter.withTransaction(async () => {
          await adapter.query('SELECT 1');
        })
      ).rejects.toThrow("use the transaction's query instead");
      await expect(
        adapter.withTransaction(() => adapter.withTransaction(async () => undefined))
      ).rejects.toThrow("use the transaction's query instead");
      // The connection is still usable afterwards.
      await shared.insertCodebase(adapter, 'cb-after');
      expect(await codebaseCount()).toBe(1);
    });

    test('a non-busy error still fails on the first attempt', async () => {
      await lockedAdapter();
      holder.run('COMMIT');
      await shared.insertCodebase(adapter, 'cb-dup');
      let attempts = 0;

      await expect(shared.insertCodebase(adapter, 'cb-dup')).rejects.toMatchObject({
        code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
      });
      await expect(
        adapter.withTransaction(async query => {
          attempts++;
          await query(
            `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
            ['cb-dup', 'cb-dup', '/tmp/test-cwd']
          );
        })
      ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
      expect(attempts).toBe(1);
    });
  });
}

const adapterDir = resolve(import.meta.dir, '..');

export function registerFreshSchemaTests(shared: ReturnType<typeof setupSqliteTests>) {
  describe('SqliteAdapter fresh schema', () => {
    /** Commit frames in the WAL: one per committed write transaction since the last checkpoint. */
    function walCommits(path: string): number {
      const wal = readFileSync(`${path}-wal`);
      const pageSize = wal.readUInt32BE(8);
      let commits = 0;
      for (let offset = 32; offset + 24 <= wal.length; offset += 24 + pageSize) {
        if (wal.readUInt32BE(offset + 4) !== 0) commits++;
      }
      return commits;
    }

    test('a fresh database receives its tables in one commit, not one per table', async () => {
      // Each commit is an fsync; per-statement commits made a first open cost seconds on
      // a slow disk.
      const path = await shared.upgradeFixturePath();
      const adapter = new SqliteAdapter(path);
      try {
        const tables = raw_query(
          path,
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'"
        ) as { n: number }[];
        expect(walCommits(path)).toBeLessThan(Number(tables[0]?.n) / 2);
      } finally {
        await adapter.close();
      }
    });

    test('opening waits out another process that holds a fresh file instead of failing', async () => {
      // Switching a file to WAL fails with SQLITE_BUSY at once, without busy_timeout,
      // while another connection holds a write lock on it. The holder releases only after
      // the opener has reported waiting, so the test always exercises the contention.
      const path = await shared.upgradeFixturePath();
      const holder = Bun.spawn(
        [
          process.execPath,
          '-e',
          `const { Database } = require('bun:sqlite');
const db = new Database(${JSON.stringify(path)});
// COMMIT needs the opener's read lock gone; without a timeout it can fail SQLITE_BUSY.
db.run('PRAGMA busy_timeout = 30000');
db.run('CREATE TABLE IF NOT EXISTS held (a)');
db.run('BEGIN IMMEDIATE');
db.run('INSERT INTO held VALUES (1)');
console.log('held');
for await (const _ of console) break;
db.run('COMMIT');`,
        ],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' }
      );
      await shared.readUntil(holder.stdout, line => line === 'held');
      const opener = Bun.spawn(
        [
          process.execPath,
          '-e',
          `const { SqliteAdapter } = await import(${JSON.stringify(join(adapterDir, 'sqlite.ts'))});
const adapter = new SqliteAdapter(${JSON.stringify(path)});
await adapter.query('SELECT COUNT(*) FROM remote_agent_codebases');
await adapter.close();`,
        ],
        { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, LOG_LEVEL: 'warn' } }
      );
      try {
        await shared.readUntil(opener.stdout, line => line.includes('db.sqlite_busy_waiting'));
      } finally {
        holder.stdin.write('release\n');
        await holder.stdin.end();
      }
      expect(await holder.exited).toBe(0);
      expect(await opener.exited).toBe(0);
    });

    test('processes opening the same fresh file at once all get the full schema', async () => {
      const path = await shared.upgradeFixturePath();
      const source = `const { SqliteAdapter } = await import(${JSON.stringify(join(adapterDir, 'sqlite.ts'))});
await new SqliteAdapter(${JSON.stringify(path)}).close();`;
      const children = Array.from({ length: 4 }, () =>
        Bun.spawn([process.execPath, '-e', source], { stdout: 'ignore', stderr: 'pipe' })
      );
      const results = await Promise.all(
        children.map(async child => ({
          code: await child.exited,
          stderr: await new Response(child.stderr).text(),
        }))
      );
      expect(results.filter(result => result.code !== 0)).toEqual([]);
      const reopened = new SqliteAdapter(path);
      try {
        await reopened.query('SELECT COUNT(*) FROM remote_agent_codebases');
      } finally {
        await reopened.close();
      }
    });
  });
}

export function registerDialectTests() {
  describe('sqliteDialect', () => {
    test('jsonText reads a dotted path with json_extract', () => {
      expect(sqliteDialect.jsonText('w.metadata', 'approval.attempt')).toBe(
        "json_extract(w.metadata, '$.approval.attempt')"
      );
    });

    test('jsonRemove removes every key in one json_remove', () => {
      expect(sqliteDialect.jsonRemove('metadata', 'approval', 'wait')).toBe(
        "json_remove(metadata, '$.approval', '$.wait')"
      );
    });

    test('rowLock is empty because SQLite has no row locks', () => {
      expect(sqliteDialect.rowLock('w')).toBe('');
    });
  });
}
