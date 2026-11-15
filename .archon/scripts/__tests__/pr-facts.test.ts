/**
 * What a metrics run asks the forge about each pull request it records: a merged one
 * once, then from the facts a run kept, and every pull request that can still change on
 * every run. The forge is faked and the state store is the real one; the host CLI is the
 * tool boundary, so each test counts the calls it saw.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { state } from 'archon:script';
import { readPrFacts } from '../../workflows/sdlc/.shared/factory-prs';
import { gitCheckout, hostCli } from './deliver-checks-harness';
import { trackTempRoots } from './temp-roots';

const FAKE_ARCHON = resolve(import.meta.dir, 'fixtures/fake-archon-pr-facts.ts');
const track = trackTempRoots();
const url = (number: number): string => `https://github.example.com/acme/widgets/pull/${String(number)}`;

const MERGED = { state: 'merged', head: 'build/a', created: '2026-10-01T00:00:00Z', merged: '2026-10-02T00:00:00Z', closed: '2026-10-02T00:00:00Z' };
const OPEN = { state: 'open', head: 'build/b', created: '2026-10-03T00:00:00Z' };
const CLOSED = { state: 'closed', head: 'build/c', created: '2026-10-04T00:00:00Z', closed: '2026-10-05T00:00:00Z' };

let dir = '';
const saved = { ...process.env };

beforeEach(() => {
  dir = track(mkdtempSync(join(tmpdir(), 'archon-pr-facts-')));
  const home = track(mkdtempSync(join(tmpdir(), 'archon-pr-facts-home-')));
  Object.assign(process.env, {
    ARCHON_HOME: home,
    HOME: home,
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    FAKE_DIR: dir,
    FAKE_HOST_CLI: JSON.stringify(hostCli()),
    FAKE_STATE_CWD: gitCheckout({}, track),
    ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, FAKE_ARCHON]),
  });
  forgeReports({ 1: MERGED, 2: OPEN, 3: CLOSED });
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

function forgeReports(prs: Record<number, Record<string, string>>): void {
  writeFileSync(join(dir, 'prs.json'), JSON.stringify(prs));
}

/** The forge reads and state writes the calls since the last check made, then forgets them. */
function calls(): string[] {
  const path = join(dir, 'calls.log');
  const seen = readFileSync(path, 'utf8').split('\n').filter(line => line !== '');
  writeFileSync(path, '');
  return seen;
}
const reads = (seen: string[]): string[] => seen.filter(call => call.startsWith('forge pr.view'));
const puts = (seen: string[]): string[] => seen.filter(call => call === 'state put');

/** The one document a run kept. */
function kept(): { name: string; revision: number } {
  const [document] = state.list('pr-facts/');
  return { name: document.name, revision: document.revision };
}

test('a merged pull request is read from the forge once; open and closed ones are read on every run, to the same facts', () => {
  const urls = [url(1), url(2), url(3)];
  const first = readPrFacts(urls);
  expect(first.map(pr => pr.state)).toEqual(['MERGED', 'OPEN', 'CLOSED']);
  const seen = calls();
  expect(reads(seen)).toEqual(['forge pr.view 1', 'forge pr.view 2', 'forge pr.view 3']);
  expect(puts(seen)).toHaveLength(1);

  const second = readPrFacts(urls);
  expect(second).toEqual(first);
  expect(reads(calls())).toEqual(['forge pr.view 2', 'forge pr.view 3']);
});

test('a kept document that does not hold the merged pull request\'s facts is read again and replaced', () => {
  const first = readPrFacts([url(1)]);
  const { name, revision } = kept();
  expect(state.put(name, { state: 'OPEN', url: url(1) }, { ifRevision: revision }).ok).toBe(true);
  calls();

  expect(readPrFacts([url(1)])).toEqual(first);
  expect(reads(calls())).toEqual(['forge pr.view 1']);
  expect(state.get(name)).toMatchObject({ revision: revision + 2, value: first[0] });
  expect(readPrFacts([url(1)])).toEqual(first);
  expect(reads(calls())).toEqual([]);
});

test('a facts document an operator deleted is kept again', () => {
  const first = readPrFacts([url(1)]);
  const { name } = kept();
  expect(state.delete(name).ok).toBe(true);
  calls();

  expect(readPrFacts([url(1)])).toEqual(first);
  expect(reads(calls())).toEqual(['forge pr.view 1']);
  expect(state.get(name).value).toEqual(first[0]);
  expect(readPrFacts([url(1)])).toEqual(first);
  expect(reads(calls())).toEqual([]);
});

test('a facts document that cannot be written is noted, and the run still has the facts', () => {
  writeFileSync(join(dir, 'put-fails'), '');
  const noted = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(readPrFacts([url(1)])[0]).toMatchObject({ url: url(1), state: 'MERGED' });
    expect(noted).toHaveBeenCalled();
    calls();
    readPrFacts([url(1)]);
    expect(reads(calls())).toEqual(['forge pr.view 1']);
  } finally {
    noted.mockRestore();
  }
});

test('a facts write the store refuses because another run kept the document first is not an error, and its facts are used', () => {
  writeFileSync(join(dir, 'put-conflicts'), '');
  const noted = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const first = readPrFacts([url(1)]);
    expect(first[0]).toMatchObject({ url: url(1), state: 'MERGED' });
    expect(noted).not.toHaveBeenCalled();
    expect(puts(calls())).toHaveLength(1);

    expect(readPrFacts([url(1)])).toEqual(first);
    expect(reads(calls())).toEqual([]);
  } finally {
    noted.mockRestore();
    rmSync(join(dir, 'put-conflicts'));
  }
});
