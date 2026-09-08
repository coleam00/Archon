import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { SqliteAdapter } from './sqlite';

const trackTempRoot = trackTempRoots();

async function fixturePath(): Promise<string> {
  return join(trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-sqlite-init-'))), 'archon.db');
}

async function holdLock(path: string, mode: 'delete' | 'wal', releaseDelay: number) {
  const ready = Promise.withResolvers<void>();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures', 'sqlite-lock.ts'),
      path,
      mode,
      String(releaseDelay),
    ],
    {
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 15_000,
      ipc(message: unknown) {
        if (message === 'locked') ready.resolve();
      },
    }
  );
  const exited = child.exited.then(async code => ({
    code,
    stderr: await new Response(child.stderr).text(),
  }));
  await Promise.race([
    ready.promise,
    exited.then(result => {
      throw new Error(`Lock fixture exited before readiness: ${JSON.stringify(result)}`);
    }),
  ]);
  let released = false;
  function release(): void {
    if (!released) {
      child.send('release');
      released = true;
    }
  }
  return {
    release,
    async stop() {
      release();
      expect(await exited).toEqual({ code: 0, stderr: '' });
    },
  };
}

describe('SqliteAdapter contended initialization', () => {
  for (const mode of ['delete', 'wal'] as const) {
    test(`waits for a separate process to release a ${mode} lock before enabling WAL`, async () => {
      const path = await fixturePath();
      const lock = await holdLock(path, mode, 300);
      let adapter: SqliteAdapter | undefined;
      try {
        lock.release();
        const started = performance.now();
        adapter = new SqliteAdapter(path);
        expect(performance.now() - started).toBeGreaterThanOrEqual(250);
        const result = await adapter.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name = 'remote_agent_workflow_runs'"
        );
        expect(result.rows).toEqual([{ name: 'remote_agent_workflow_runs' }]);
      } finally {
        await adapter?.close();
        await lock.stop();
      }
      await unlink(path);
    });
  }

  test('refuses a retained lock after the existing five second budget and closes the failed handle', async () => {
    const path = await fixturePath();
    const lock = await holdLock(path, 'wal', 0);
    const close = spyOn(Database.prototype, 'close');
    let failure: unknown;
    const started = performance.now();
    try {
      try {
        await new SqliteAdapter(path).close();
      } catch (error) {
        failure = error;
      }
      const elapsed = performance.now() - started;
      expect(failure).toMatchObject({ code: 'SQLITE_BUSY', errno: 5 });
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(7_000);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      await lock.stop();
    }
    // No GC: Windows must be able to delete the file as soon as both owners close.
    await unlink(path);
  }, 10_000);

  test('closes a handle when schema initialization fails and preserves the SQLite error', async () => {
    const path = await fixturePath();
    const db = new Database(path);
    db.run('CREATE VIEW remote_agent_conversations AS SELECT 1 AS id');
    db.close();
    const close = spyOn(Database.prototype, 'close');
    let failure: unknown;
    try {
      try {
        await new SqliteAdapter(path).close();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'SQLITE_ERROR', errno: 1 });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
    await unlink(path);
  });
});
