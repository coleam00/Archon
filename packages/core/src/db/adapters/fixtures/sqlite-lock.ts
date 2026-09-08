import { Database } from 'bun:sqlite';

const [path, mode, delay] = process.argv.slice(2);
const db = new Database(path);
try {
  db.run(`PRAGMA journal_mode = ${mode === 'wal' ? 'WAL' : 'DELETE'}`);
  // In WAL mode, exclusive locking_mode also excludes new readers at startup.
  db.run('PRAGMA locking_mode = EXCLUSIVE');
  db.run('BEGIN EXCLUSIVE');
  db.run('CREATE TABLE IF NOT EXISTS lock_fixture (id INTEGER)');
  const release = new Promise<void>(resolve => {
    process.once('message', () => {
      resolve();
    });
  });
  process.send?.('locked');
  await release;
  await Bun.sleep(Number(delay));
  db.run('COMMIT');
} finally {
  db.close();
  process.disconnect?.();
}
