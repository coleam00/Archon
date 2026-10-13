// TEMPORARY Windows IO diagnostic. Not for merge.
import { Database } from 'bun:sqlite';
import { closeSync, fsyncSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../packages/core/src/db/adapters/sqlite';

const roots = { C: tmpdir(), D: process.env.RUNNER_TEMP ?? tmpdir() };
for (const [name, root] of Object.entries(roots)) {
  const dir = mkdtempSync(join(root, 'diag-io-'));
  const fd = openSync(join(dir, 'f'), 'w');
  const lat: number[] = [];
  for (let i = 0; i < 40; i++) {
    writeSync(fd, 'x'.repeat(4096));
    const s = performance.now();
    fsyncSync(fd);
    lat.push(performance.now() - s);
  }
  closeSync(fd);
  lat.sort((a, b) => a - b);
  console.log(
    `${name} fsync ms: p50=${lat[20].toFixed(1)} p90=${lat[36].toFixed(1)} max=${lat[39].toFixed(1)}`
  );
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    const a = new SqliteAdapter(join(dir, `fresh-${i}.db`));
    const ms = performance.now() - s;
    void a;
    console.log(`${name} fresh SqliteAdapter #${i}: ${ms.toFixed(0)} ms`);
  }
  for (let i = 0; i < 2; i++) {
    const db = new Database(join(dir, `count-${i}.db`));
    db.run('PRAGMA journal_mode = WAL');
    const s = performance.now();
    for (let k = 0; k < 60; k++)
      db.run(`CREATE TABLE IF NOT EXISTS t${k} (id INTEGER PRIMARY KEY, v TEXT)`);
    const auto = performance.now() - s;
    const db2 = new Database(join(dir, `tx-${i}.db`));
    db2.run('PRAGMA journal_mode = WAL');
    const s2 = performance.now();
    db2.run('BEGIN');
    for (let k = 0; k < 60; k++)
      db2.run(`CREATE TABLE IF NOT EXISTS t${k} (id INTEGER PRIMARY KEY, v TEXT)`);
    db2.run('COMMIT');
    console.log(
      `${name} 60 CREATE TABLE autocommit=${auto.toFixed(0)} ms, one transaction=${(performance.now() - s2).toFixed(0)} ms`
    );
  }
}
