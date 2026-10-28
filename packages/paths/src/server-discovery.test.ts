import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureStoreId,
  getServerRecordPath,
  getStoreIdPath,
  readLiveServerRecord,
  readStoreId,
  removeServerRecord,
  writeServerRecord,
  type ServerRecord,
} from './server-discovery';
import { trackTempRoots } from './test-utils';

const trackTempRoot = trackTempRoots();
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function makeHome(): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-discovery-')));
}

function record(home: string, pid = process.pid): ServerRecord {
  return {
    pid,
    port: 3456,
    host: '127.0.0.1',
    version: '1.2.3',
    startedAt: new Date(0).toISOString(),
    storeId: ensureStoreId(home),
  };
}

describe('store id', () => {
  test('is generated once and kept for the home', () => {
    const home = makeHome();
    expect(readStoreId(home)).toBeNull();
    const id = ensureStoreId(home);
    expect(ensureStoreId(home)).toBe(id);
    expect(readStoreId(home)).toBe(id);
    expect(ensureStoreId(makeHome())).not.toBe(id);
    if (process.platform !== 'win32')
      expect(statSync(getStoreIdPath(home)).mode & 0o777).toBe(0o600);
  });

  test('a file that is not a store id is refused, never replaced', () => {
    const home = makeHome();
    writeFileSync(getStoreIdPath(home), 'not-an-id\n');
    expect(readStoreId(home)).toBeNull();
    expect(() => ensureStoreId(home)).toThrow('is not a store id');
    expect(readFileSync(getStoreIdPath(home), 'utf8')).toBe('not-an-id\n');
  });
});

describe('server record', () => {
  test('a written record for a live process is found', () => {
    const home = makeHome();
    writeServerRecord(record(home), home);
    expect(readLiveServerRecord(home)).toEqual(record(home));
    if (process.platform !== 'win32')
      expect(statSync(getServerRecordPath(home)).mode & 0o777).toBe(0o600);
  });

  test('a missing, malformed, unusable-port or dead-process record means no server', () => {
    const home = makeHome();
    expect(readLiveServerRecord(home)).toBeNull();
    writeFileSync(getServerRecordPath(home), '{"pid":');
    expect(readLiveServerRecord(home)).toBeNull();
    for (const port of [-1, 0, 65536, 3456.5]) {
      writeServerRecord({ ...record(home), port }, home);
      expect(readLiveServerRecord(home)).toBeNull();
    }

    writeServerRecord(record(home, 424242), home);
    spies.push(
      spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      })
    );
    expect(readLiveServerRecord(home)).toBeNull();
  });

  test('a server removes only the record that names it', () => {
    const home = makeHome();
    writeServerRecord(record(home, 424242), home);
    removeServerRecord(process.pid, home);
    expect(JSON.parse(readFileSync(getServerRecordPath(home), 'utf8'))).toMatchObject({
      pid: 424242,
    });
    removeServerRecord(424242, home);
    expect(() => statSync(getServerRecordPath(home))).toThrow();
  });
});
