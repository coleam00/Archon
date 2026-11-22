import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  type Baseline,
  collectInChildren,
  collectSites,
  compareBaseline,
  computeBaseline,
  mockingFiles,
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

  test('a scoped comparison ignores baseline entries outside its scope', () => {
    const { root } = project("mock.module('./db', () => ({ getRun() {}, deleteRun() {} }));");
    const { sites } = collectSites(root, [join(root, 'src/a.test.ts')]);
    const outside: Baseline = {
      factories: { 'other/b.test.ts': ['./db'] },
      exports: { 'src/db.ts': ['deleteRun'] },
    };
    expect(compareBaseline(sites, outside, ['src'])).toEqual([]);
    expect(compareBaseline(sites, outside)).toHaveLength(3);
  });

  test('a scoped comparison still refuses an in-scope site and a stale in-scope entry', () => {
    const { root } = project(partial);
    const { sites } = collectSites(root, [join(root, 'src/a.test.ts')]);
    expect(compareBaseline(sites, EMPTY, ['src'])[0]).toStartWith(
      "src/a.test.ts:2 mock.module('./db') omits deleteRun;"
    );
    const stale = { factories: { 'src/a.test.ts': ['./db', './gone'] }, exports: {} };
    expect(compareBaseline(sites, stale, ['src'])).toContain(
      "scripts/mock-module-baseline.json: src/a.test.ts no longer mocks './gone' incompletely"
    );
  });

  test('a scoped run reads only the mocking files under its directories', () => {
    const { root } = project(partial);
    mkdirSync(join(root, 'packages/a'), { recursive: true });
    mkdirSync(join(root, 'packages/b'), { recursive: true });
    writeFileSync(join(root, 'packages/a/x.test.ts'), partial);
    writeFileSync(join(root, 'packages/b/y.test.ts'), partial);
    writeFileSync(join(root, 'packages/b/plain.ts'), 'export {};\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
    expect(mockingFiles(root, ['packages/a'])).toEqual([join(root, 'packages/a/x.test.ts')]);
    expect(mockingFiles(root, undefined)).toEqual([
      join(root, 'packages/a/x.test.ts'),
      join(root, 'packages/b/y.test.ts'),
    ]);
  });

  // `bun run lint` reads each tsconfig's files in a child process; these cover that path.
  test('a child process reports the same sites as an in-process read', () => {
    const { root } = project(partial);
    const files = [join(root, 'src/a.test.ts')];
    const collected = collectInChildren(root, files);
    expect(collected.sites.map(site => site.omitted)).toEqual([['deleteRun']]);
    expect(collected).toEqual(collectSites(root, files));
  });

  test('a child that fails fails the check instead of reading as no sites', () => {
    const { root } = project(partial);
    expect(() => collectInChildren(root, [join(root, 'src/missing.test.ts')])).toThrow(
      'Reading the mock.module() sites tsconfig.json owns failed (exit 1)'
    );
  });
});
