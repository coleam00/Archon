/**
 * What a metrics run asks the forge about each pull request it records: a merged one
 * once, then from the facts a run kept, and every pull request that can still change on
 * every run. The host CLI is the tool boundary, so each test counts the calls it saw.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type PrFacts, readPrFacts } from '../../workflows/sdlc/.shared/factory-prs';
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
  Object.assign(process.env, { FAKE_DIR: dir, ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, FAKE_ARCHON]) });
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

test('a merged pull request is read from the forge once; open and closed ones are read on every run, to the same facts', () => {
  const urls = [url(1), url(2), url(3)];
  const first = readPrFacts(urls);
  expect(first.map(pr => pr.state)).toEqual(['MERGED', 'OPEN', 'CLOSED']);
  const seen = calls();
  expect(reads(seen)).toEqual(['forge pr.view 1', 'forge pr.view 2', 'forge pr.view 3']);
  expect(seen.filter(call => call === 'state put')).toHaveLength(1);

  const second = readPrFacts(urls);
  expect(second).toEqual(first);
  expect(reads(calls())).toEqual(['forge pr.view 2', 'forge pr.view 3']);
});

test('a pull request merged after a run recorded it open is read once more, then kept', () => {
  readPrFacts([url(2)]);
  calls();
  forgeReports({ 2: { ...OPEN, state: 'merged', merged: '2026-10-06T00:00:00Z', closed: '2026-10-06T00:00:00Z' } });

  expect(readPrFacts([url(2)])[0]).toMatchObject({ state: 'MERGED', mergedAt: '2026-10-06T00:00:00Z' });
  expect(reads(calls())).toEqual(['forge pr.view 2']);
  expect(readPrFacts([url(2)])[0]).toMatchObject({ state: 'MERGED', mergedAt: '2026-10-06T00:00:00Z' });
  expect(reads(calls())).toEqual([]);
});

test('a kept document that is not a merged pull request\'s facts is read again and replaced', () => {
  const stored = join(dir, 'state.json');
  const first = readPrFacts([url(1)]);
  const documents = JSON.parse(readFileSync(stored, 'utf8')) as Record<string, { revision: number; value: unknown }>;
  const [name] = Object.keys(documents);
  writeFileSync(stored, JSON.stringify({ [name]: { revision: 1, value: { state: 'OPEN' } } }));
  calls();

  expect(readPrFacts([url(1)])).toEqual(first);
  expect(reads(calls())).toEqual(['forge pr.view 1']);
  expect(JSON.parse(readFileSync(stored, 'utf8'))[name]).toEqual({ revision: 2, value: first[0] satisfies PrFacts });
  expect(readPrFacts([url(1)])).toEqual(first);
  expect(reads(calls())).toEqual([]);
});

test('a facts document that cannot be written is noted, and the run still has the facts', () => {
  writeFileSync(join(dir, 'put-fails'), '');
  const noted = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(readPrFacts([url(1)])[0]).toMatchObject({ url: url(1), state: 'MERGED' });
    expect(String(noted.mock.calls[0]?.[0])).toContain(`could not keep the facts of ${url(1)}`);
    calls();
    readPrFacts([url(1)]);
    expect(reads(calls())).toEqual(['forge pr.view 1']);
  } finally {
    noted.mockRestore();
  }
});

test('a facts write the store refuses because another run moved the document first is not an error', () => {
  writeFileSync(join(dir, 'put-conflicts'), '');
  const noted = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(readPrFacts([url(1)])[0]).toMatchObject({ url: url(1), state: 'MERGED' });
    expect(noted).not.toHaveBeenCalled();
  } finally {
    noted.mockRestore();
  }
});
