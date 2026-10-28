/**
 * How a client on the same machine finds a running Archon server and checks that it
 * serves the Archon home the client means.
 *
 * Each home holds an opaque `store-id`, generated once and kept for the home's life, and
 * a server writes `server.json` under its home while it listens, plus its own record in
 * `server-records/`, so the home stays discoverable while any of several servers sharing
 * it still listens. `GET /api/health`
 * returns the same store id, so a client that compares the health response with the
 * home's own file can tell a server for another home from the right one.
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getArchonHome } from './home-paths';
import { isPidProvablyGone } from './process-owner';

const STORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function getStoreIdPath(archonHome: string = getArchonHome()): string {
  return join(archonHome, 'store-id');
}

export function getServerRecordPath(archonHome: string = getArchonHome()): string {
  return join(archonHome, 'server.json');
}

/** One `<pid>.json` record per listening server, so a stopping server can hand `server.json` on. */
export function getServerRecordsDir(archonHome: string = getArchonHome()): string {
  return join(archonHome, 'server-records');
}

function readFileIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Writable only by the home's owner; `writeFileSync`'s mode is diluted by the umask. */
function restrictToOwner(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and filesystems without POSIX permissions keep their defaults.
  }
}

/** The home's store id, or null when the home has none or its file is not one. */
export function readStoreId(archonHome: string = getArchonHome()): string | null {
  const content = readFileIfPresent(getStoreIdPath(archonHome))?.trim();
  return content !== undefined && STORE_ID_PATTERN.test(content) ? content : null;
}

/**
 * The home's store id, generated on first use. A random UUID, never derived from a path
 * or the machine. Throws when the file exists but holds something else, since replacing
 * it would change the identity clients already compare against.
 */
export function ensureStoreId(archonHome: string = getArchonHome()): string {
  const path = getStoreIdPath(archonHome);
  const existing = readFileIfPresent(path);
  if (existing !== null) {
    const id = existing.trim();
    if (STORE_ID_PATTERN.test(id)) return id;
    throw new Error(
      `Store id file at ${path} is not a store id. Delete it to generate a new one; ` +
        'clients that recorded the old id will treat this home as a different store.'
    );
  }
  mkdirSync(archonHome, { recursive: true });
  const id = randomUUID();
  const tempPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${id}\n`, { mode: 0o600 });
    restrictToOwner(tempPath);
    // A hard link publishes the complete file and fails when it exists, so two servers
    // starting on one home agree on the first id written.
    linkSync(tempPath, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return ensureStoreId(archonHome);
  } finally {
    rmSync(tempPath, { force: true });
  }
  return id;
}

/**
 * The discovery record a listening server keeps at `$ARCHON_HOME/server-records/<pid>.json`
 * and, while it is the newest live server for the home, at `$ARCHON_HOME/server.json`.
 */
export interface ServerRecord {
  pid: number;
  port: number;
  /** The address the server is bound to, such as `0.0.0.0` or `127.0.0.1`. */
  host: string;
  version: string;
  /** ISO 8601 time the server started listening. */
  startedAt: string;
  storeId: string;
}

function parseServerRecord(value: unknown): ServerRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { pid, port, host, version, startedAt, storeId } = record;
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof host !== 'string' ||
    typeof version !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof storeId !== 'string'
  ) {
    return null;
  }
  return { pid, port, host, version, startedAt, storeId };
}

function readRecordFile(path: string): ServerRecord | null {
  try {
    const content = readFileIfPresent(path);
    return content === null ? null : parseServerRecord(JSON.parse(content));
  } catch {
    return null;
  }
}

/** Replace a record file atomically, so a reader never sees a partial file. */
function writeRecordFile(path: string, record: ServerRecord): void {
  const tempPath = `${path}.${String(record.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    restrictToOwner(tempPath);
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * The per-server records whose process may still run, newest first. With `prune`, the
 * records of servers that are provably gone (killed before they could clean up) are deleted;
 * only servers prune, never a reader.
 */
function liveServerRecords(archonHome: string, prune: boolean): ServerRecord[] {
  const dir = getServerRecordsDir(archonHome);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const live: ServerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const record = readRecordFile(path);
    if (record && !isPidProvablyGone(record.pid)) live.push(record);
    else if (record && prune) rmSync(path, { force: true });
  }
  // Every writer stamps `startedAt` with `toISOString()`, so string order is time order.
  return live.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * The server recorded for this home, or null when there is none. The record is advisory:
 * a missing, unreadable or malformed file, or one whose process no longer exists (the
 * server was killed before it could remove it), all mean no server. When `server.json`
 * names no live server, the newest live per-server record answers instead.
 */
export function readLiveServerRecord(archonHome: string = getArchonHome()): ServerRecord | null {
  const record = readRecordFile(getServerRecordPath(archonHome));
  if (record && !isPidProvablyGone(record.pid)) return record;
  try {
    return liveServerRecords(archonHome, false)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Publish a listening server: its own record first, so a server stopping at the same moment
 * can already hand `server.json` to it, then `server.json`. Both writes are atomic.
 */
export function writeServerRecord(
  record: ServerRecord,
  archonHome: string = getArchonHome()
): void {
  mkdirSync(getServerRecordsDir(archonHome), { recursive: true });
  liveServerRecords(archonHome, true);
  writeRecordFile(join(getServerRecordsDir(archonHome), `${String(record.pid)}.json`), record);
  writeRecordFile(getServerRecordPath(archonHome), record);
}

/**
 * Withdraw a stopping server. Several servers can share one home (one per worktree), and the
 * most recent to start owns `server.json`: an older one stopping leaves it alone, and the
 * owner stopping hands it to the newest server still running, or removes it when none is.
 */
export function removeServerRecord(pid: number, archonHome: string = getArchonHome()): void {
  rmSync(join(getServerRecordsDir(archonHome), `${String(pid)}.json`), { force: true });
  const path = getServerRecordPath(archonHome);
  if (readRecordFile(path)?.pid !== pid) return;
  const successor = liveServerRecords(archonHome, true)[0];
  if (successor) writeRecordFile(path, successor);
  else rmSync(path, { force: true });
}
