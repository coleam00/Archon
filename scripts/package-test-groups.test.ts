import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  parseTestPart,
  partitionTestGroups,
  resolvePackageTestConcurrency,
  resolvePackageTestGroups,
  TEST_ISOLATION_DIRECTIVE,
} from './package-test-groups';
import weights from './test-weights.json';
import { inspectPackage, isCollectedByRepositoryTest } from './test-inventory.test';

const track = trackTempRoots();
function fixture(): string {
  return track(mkdtempSync(join(tmpdir(), 'test-discovery-')));
}
function write(root: string, path: string, source = ''): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), source);
}

test('discovers suffixes and dot directories, partitions exact directives, and includes additions', () => {
  const root = fixture();
  write(root, 'src/a.test.ts', TEST_ISOLATION_DIRECTIVE);
  write(root, 'src/b.spec.ts', `\uFEFF${TEST_ISOLATION_DIRECTIVE}\r\n`);
  write(root, 'src/nested/c.test.tsx', `\n${TEST_ISOLATION_DIRECTIVE}`);
  write(root, 'src/.hidden/d.spec.tsx', `${TEST_ISOLATION_DIRECTIVE} extra`);
  write(root, 'src/not-a-test.ts');
  write(root, 'outside.test.ts');
  expect(resolvePackageTestGroups(root, {})).toEqual([
    ['src/a.test.ts'],
    ['src/b.spec.ts'],
    ['src/.hidden/d.spec.tsx', 'src/nested/c.test.tsx'],
  ]);
  write(root, 'src/new.test.ts');
  expect(resolvePackageTestGroups(root, {}).at(-1)).toEqual([
    'src/.hidden/d.spec.tsx',
    'src/nested/c.test.tsx',
    'src/new.test.ts',
  ]);
});

test('a direct mock.module() call without the directive fails discovery', () => {
  const root = fixture();
  const mocking = "mock.module('./value', () => ({}));\n";
  write(root, 'src/marked.test.ts', `${TEST_ISOLATION_DIRECTIVE}\n${mocking}`);
  write(root, 'src/plain.test.ts');
  expect(resolvePackageTestGroups(root, {})).toEqual([
    ['src/marked.test.ts'],
    ['src/plain.test.ts'],
  ]);
  write(root, 'src/unmarked.test.ts', mocking);
  expect(() => resolvePackageTestGroups(root, {})).toThrow('src/unmarked.test.ts');
});

test('legacy groups retain their order and malformed declarations fail', () => {
  const root = fixture();
  const groups = [['src/z.test.ts', 'src/a.test.ts'], ['src/nested/']];
  expect(resolvePackageTestGroups(root, { testGroups: groups })).toEqual(groups);
  for (const declaration of [
    null,
    { testGroups: [] },
    { testGroups: [[]] },
    { testGroups: [['']] },
    { testGroups: [[1]] },
    { testGroups: 'src/' },
  ]) {
    expect(() => resolvePackageTestGroups(root, declaration)).toThrow();
  }
});

test('group concurrency defaults to one and rejects anything but a positive integer', () => {
  expect(resolvePackageTestConcurrency({})).toBe(1);
  expect(resolvePackageTestConcurrency({ testConcurrency: 3 })).toBe(3);
  for (const testConcurrency of [0, 1.5, '2', null]) {
    expect(() => resolvePackageTestConcurrency({ testConcurrency })).toThrow(
      'testConcurrency must be a positive integer'
    );
  }
});

test('a test part is <index>/<count> within range, and unset means the whole suite', () => {
  expect(parseTestPart(undefined)).toBeUndefined();
  expect(parseTestPart('')).toBeUndefined();
  expect(parseTestPart('2/3')).toEqual({ index: 2, count: 3 });
  for (const value of ['0/2', '3/2', '1', '1/0', 'a/b', '1/2/3', ' 1/2']) {
    expect(() => parseTestPart(value)).toThrow('ARCHON_TEST_PART');
  }
});

test('parts hold every group exactly once, balanced by weight and slowest first', () => {
  const groups = [['a'], ['b'], ['c', 'c2'], ['d'], ['e']];
  const parts = partitionTestGroups(groups, { a: 10, b: 6, c: 5, d: 1 }, 2);
  expect(parts).toEqual([
    [['a'], ['d'], ['e']],
    [['b'], ['c', 'c2']],
  ]);
  // More parts than groups leaves the extra parts empty rather than dropping or repeating one.
  expect(partitionTestGroups(groups, {}, 7).flat()).toHaveLength(groups.length);
  expect(partitionTestGroups(groups, {}, 7).filter(part => part.length === 0)).toHaveLength(2);
});

// The coverage proof for CI's split shards: whatever the recorded weights, the parts of every
// real package together are exactly its groups.
test('every package splits into parts that together run each of its groups once', async () => {
  const packagesDir = join(import.meta.dir, '..', 'packages');
  for (const manifestPath of new Bun.Glob('*/package.json').scanSync({ cwd: packagesDir })) {
    const manifest = (await Bun.file(join(packagesDir, manifestPath)).json()) as { name: string };
    const groups = resolvePackageTestGroups(join(packagesDir, manifestPath, '..'), manifest);
    const packageWeights = (weights as Record<string, Record<string, number>>)[manifest.name];
    for (const count of [1, 2, 3]) {
      const parts = partitionTestGroups(groups, packageWeights ?? {}, count);
      expect(parts).toHaveLength(count);
      expect(parts.flat().sort()).toEqual([...groups].sort());
    }
  }
});

test('inventory accepts independent additions and rejects invalid groups and stale selectors', () => {
  const root = fixture();
  const manifest = {
    scripts: { test: 'bun run ../../scripts/package-tests.ts' },
  };
  write(root, 'package.json', JSON.stringify(manifest));
  write(root, 'src/one.test.ts');
  expect(inspectPackage(root)).toBeUndefined();
  write(root, 'src/nested/two.test.ts');
  expect(inspectPackage(root)).toBeUndefined();
  write(
    root,
    'package.json',
    JSON.stringify({ testGroups: [['src/']], scripts: { test: 'bun test src/' } })
  );
  expect(inspectPackage(root)?.unsupportedDeclarations.length).toBe(1);
  write(
    root,
    'package.json',
    JSON.stringify({ scripts: manifest.scripts, testGroups: [['src/missing.test.ts']] })
  );
  expect(inspectPackage(root)?.staleSelectors).toEqual(['src/missing.test.ts']);
  expect(inspectPackage(root)?.missingTests).toEqual(['src/nested/two.test.ts', 'src/one.test.ts']);
  write(root, 'package.json', JSON.stringify({ scripts: manifest.scripts, testGroups: [[]] }));
  expect(inspectPackage(root)?.unsupportedDeclarations.length).toBe(1);
  expect(
    isCollectedByRepositoryTest(
      'packages/core/outside.test.ts',
      [],
      ['packages/*'],
      true,
      new Map()
    )
  ).toBe(false);
});

test('discovery errors remain visible and explicit script chains still cover tests', () => {
  const root = fixture();
  expect(() => resolvePackageTestGroups(root, {})).toThrow('found no tests under src');
  expect(() => resolvePackageTestGroups(join(root, 'missing'), {})).toThrow();
  write(root, 'src/one.test.ts');
  write(root, 'src/nested/two.test.ts');
  write(
    root,
    'package.json',
    JSON.stringify({ scripts: { test: 'bun test src/one.test.ts && bun test src/nested/' } })
  );
  expect(inspectPackage(root)).toBeUndefined();
  write(
    root,
    'package.json',
    JSON.stringify({ scripts: { test: 'bun run ../../scripts/package-tests.ts' } })
  );
  expect(inspectPackage(root)).toBeUndefined();
});
