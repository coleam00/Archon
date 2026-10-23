import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  type Baseline,
  collectSites,
  compareBaseline,
  computeBaseline,
} from './check-mock-modules';

const track = trackTempRoots();

const DB =
  'export function getRun() {}\nexport function deleteRun() {}\nexport type Run = { id: string };\n';
const EMPTY: Baseline = { factories: {}, exports: {} };

/** A fixture project whose test file mocks `./db` with `factory`; returns the check's failures. */
function project(factory: string, db = DB): { root: string; check: (b: Baseline) => string[] } {
  const root = track(realpathSync(mkdtempSync(join(tmpdir(), 'mock-modules-'))));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022'],
        strict: true,
        types: [],
      },
    })
  );
  writeFileSync(join(root, 'src/db.ts'), db);
  writeFileSync(
    join(root, 'src/a.test.ts'),
    `declare const mock: { module(path: string, factory: () => unknown): void };\n${factory}\n`
  );
  const check = (baseline: Baseline): string[] => {
    const { sites, errors } = collectSites(root, [join(root, 'src/a.test.ts')]);
    return [...errors, ...compareBaseline(sites, baseline)];
  };
  return { root, check };
}

const partial = "mock.module('./db', () => ({ getRun: () => {} }));";

describe('check-mock-modules', () => {
  test('refuses a factory that omits an export, naming the site and the export', () => {
    const { check } = project(partial);
    const failures = check(EMPTY);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("src/a.test.ts:2 mock.module('./db') omits deleteRun;");
  });

  test('a grandfathered site fails when its module gains an export', () => {
    const { root, check } = project(partial);
    const baseline = computeBaseline(collectSites(root, [join(root, 'src/a.test.ts')]).sites);
    expect(baseline).toEqual({
      factories: { 'src/a.test.ts': ['./db'] },
      exports: { 'src/db.ts': ['deleteRun'] },
    });
    expect(check(baseline)).toEqual([]);

    writeFileSync(join(root, 'src/db.ts'), `${DB}export function findChildRuns() {}\n`);
    const failures = check(baseline);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("src/a.test.ts:2 mock.module('./db') omits findChildRuns;");
  });

  test('a factory that spreads the real module passes without a baseline entry', () => {
    const { check } = project(
      "mock.module('./db', async () => ({ ...(await import('./db')), getRun: () => {} }));"
    );
    expect(check(EMPTY)).toEqual([]);
  });

  test('refuses a baseline entry no incomplete site needs', () => {
    const { check } = project("mock.module('./db', () => ({ getRun() {}, deleteRun() {} }));");
    const failures = check({
      factories: { 'src/a.test.ts': ['./db'] },
      exports: { 'src/db.ts': ['deleteRun'] },
    });
    expect(failures).toHaveLength(3);
    expect(failures.at(-1)).toContain('bun run check:mock-modules --write');
  });

  test('refuses a mock of a path that does not resolve', () => {
    const { check } = project("mock.module('./gone', () => ({}));");
    expect(check(EMPTY)).toEqual([
      "src/a.test.ts:2 mock.module('./gone') does not resolve; a mock of a path nothing imports is dead",
    ]);
  });
});
