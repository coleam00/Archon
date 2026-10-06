import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { resolvePackageTestGroups, TEST_ISOLATION_DIRECTIVE } from './package-test-groups';
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
  expect(resolvePackageTestGroups(root, { testDiscovery: true })).toEqual([
    ['src/a.test.ts'],
    ['src/b.spec.ts'],
    ['src/.hidden/d.spec.tsx', 'src/nested/c.test.tsx'],
  ]);
  write(root, 'src/new.test.ts');
  expect(resolvePackageTestGroups(root, { testDiscovery: true }).at(-1)).toEqual([
    'src/.hidden/d.spec.tsx',
    'src/nested/c.test.tsx',
    'src/new.test.ts',
  ]);
});

test('legacy groups retain their order and malformed declarations fail', () => {
  const root = fixture();
  const groups = [['src/z.test.ts', 'src/a.test.ts'], ['src/nested/']];
  expect(resolvePackageTestGroups(root, { testGroups: groups })).toEqual(groups);
  for (const declaration of [
    null,
    {},
    { testGroups: [] },
    { testGroups: [[]] },
    { testGroups: [['']] },
    { testGroups: [[1]] },
    { testGroups: 'src/' },
    { testDiscovery: false },
    { testDiscovery: 'true' },
    { testGroups: groups, testDiscovery: true },
    { testDiscovery: true },
  ]) {
    expect(() => resolvePackageTestGroups(root, declaration)).toThrow();
  }
});

test('inventory accepts independent additions and rejects incomplete adoption and stale selectors', () => {
  const root = fixture();
  const manifest = {
    scripts: { test: 'bun run ../../scripts/package-tests.ts' },
    testDiscovery: true,
  };
  write(root, 'package.json', JSON.stringify(manifest));
  write(root, 'src/one.test.ts');
  expect(inspectPackage(root)).toBeUndefined();
  write(root, 'src/nested/two.test.ts');
  expect(inspectPackage(root)).toBeUndefined();
  write(root, 'package.json', JSON.stringify({ ...manifest, scripts: { test: 'bun test src/' } }));
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
  expect(() => resolvePackageTestGroups(join(root, 'missing'), { testDiscovery: true })).toThrow();
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
  expect(inspectPackage(root)?.unsupportedDeclarations.length).toBe(1);
});
