/**
 * Read-only probes of a SQLite file, for the adapter suites that assert what an open or an
 * upgrade left on disk without going through the adapter under test.
 */
import { Database } from 'bun:sqlite';

export function raw_pragma(dbPath: string, table: string): string[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.query(`PRAGMA table_info('${table}')`).all() as { name: string }[];
    return rows.map(r => r.name);
  } finally {
    raw.close();
  }
}

export function raw_indexes(dbPath: string): string[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const rows = raw.query("SELECT name FROM sqlite_master WHERE type='index'").all() as {
      name: string;
    }[];
    return rows.map(r => r.name);
  } finally {
    raw.close();
  }
}

export function raw_query(dbPath: string, sql: string): unknown[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    // query(), not prepare(): close() finalizes query() statements, while a prepared one
    // keeps the file open and Windows then refuses to remove the temp root.
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}
