import { SqliteAdapter } from '../sqlite';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { trackTempRoots } from '@archon/paths/test-utils';
import { resolve } from 'node:path';

const adapterDir = resolve(import.meta.dir, '..');

export function setupSqliteTests() {
  let currentDbPath = '';

  function createTestDb(): SqliteAdapter {
    currentDbPath = join(
      adapterDir,
      `.test-sqlite-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    return new SqliteAdapter(currentDbPath);
  }

  /** Insert a parent codebase row to satisfy FK constraints */
  async function insertCodebase(db: SqliteAdapter, id: string): Promise<void> {
    await db.query(
      `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
      [id, `test-codebase-${id}`, '/tmp/test-cwd']
    );
  }

  const trackTempRoot = trackTempRoots();

  /**
   * A fresh on-disk database path for one upgrade fixture, reclaimed after the test.
   *
   * A real file, not a `file:...?mode=memory&cache=shared` URI: bun:sqlite opens without
   * `SQLITE_OPEN_URI`, so SQLite reads such a URI as a literal filename and creates it in
   * the process cwd — which is how these fixtures used to leave `file:archon-test-sqlite-*`
   * files under `packages/core/`. The adapter has no URI requirement, and the fixture only
   * needs a database that survives being reopened.
   */
  async function upgradeFixturePath(): Promise<string> {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-core-sqlite-upgrade-')));
    return join(root, 'archon.db');
  }

  /** Read a child's stdout line by line until `done` accepts one; the stream may split lines. */
  async function readUntil(
    stream: ReadableStream<Uint8Array>,
    done: (line: string) => boolean
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      if (lines.some(line => done(line.trim()))) return;
    }
    throw new Error('stream ended before the expected line');
  }
  return {
    get currentDbPath() {
      return currentDbPath;
    },
    set currentDbPath(value: string) {
      currentDbPath = value;
    },
    createTestDb,
    insertCodebase,
    trackTempRoot,
    upgradeFixturePath,
    readUntil,
  };
}
