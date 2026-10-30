import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TEST_ISOLATION_DIRECTIVE = '// @archon-test-isolated';

export function resolvePackageTestGroups(
  packageDirectory: string,
  declaration: unknown,
  selectedFiles?: readonly string[],
  onDiscoveryError?: (error: Error) => void
): string[][] {
  if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
    throw new Error('Package test declaration must be an object');
  }
  const groups = 'testGroups' in declaration ? declaration.testGroups : undefined;
  if (groups !== undefined) {
    if (
      !Array.isArray(groups) ||
      groups.length === 0 ||
      !groups.every(
        (group): group is string[] =>
          Array.isArray(group) &&
          group.length > 0 &&
          group.every(
            (selector): selector is string => typeof selector === 'string' && selector.length > 0
          )
      )
    )
      throw new Error('testGroups must contain nonempty arrays of string selectors');
    return groups;
  }

  return groupDiscoveredTestFiles(
    packageDirectory,
    selectedFiles ?? discoverPackageTestFiles(packageDirectory),
    onDiscoveryError
  );
}

function groupDiscoveredTestFiles(
  packageDirectory: string,
  files: readonly string[],
  onDiscoveryError?: (error: Error) => void
): string[][] {
  if (files.length === 0) throw new Error('Test discovery found no tests under src');
  const isolated: string[][] = [];
  const shared: string[] = [];
  const unmarkedMocks: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(packageDirectory, file), 'utf8').replace(/^\uFEFF/, '');
    if (source.split(/\r?\n/, 1)[0] === TEST_ISOLATION_DIRECTIVE) isolated.push([file]);
    else if (source.includes('mock.module(')) unmarkedMocks.push(file);
    else shared.push(file);
  }
  // A direct mock.module() call in the shared process would leak into every other
  // unmarked file. Mocks reached through a helper cannot be seen here; those files
  // still need the directive by hand.
  if (unmarkedMocks.length > 0) {
    const error = new Error(
      `These tests call mock.module() but do not start with "${TEST_ISOLATION_DIRECTIVE}": ${unmarkedMocks.join(', ')}`
    );
    if (onDiscoveryError === undefined) throw error;
    onDiscoveryError(error);
  }
  return shared.length > 0 ? [...isolated, shared] : isolated;
}

export function discoverPackageTestFiles(packageDirectory: string): string[] {
  return [
    ...new Set(
      new Bun.Glob('src/**/*.{test,spec}.{ts,tsx}').scanSync({
        cwd: packageDirectory,
        onlyFiles: true,
        dot: true,
      })
    ),
  ]
    .map(path => path.replaceAll('\\', '/'))
    .sort();
}

/** How many of a package's test groups may run at once; 1 when the manifest does not say. */
export function resolvePackageTestConcurrency(declaration: unknown): number {
  if (typeof declaration !== 'object' || declaration === null || Array.isArray(declaration)) {
    throw new Error('Package test declaration must be an object');
  }
  const concurrency = 'testConcurrency' in declaration ? declaration.testConcurrency : undefined;
  if (concurrency === undefined) return 1;
  if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('testConcurrency must be a positive integer');
  }
  return concurrency;
}

/** One slice of a suite that CI spreads across `count` runners: `index` is 1-based. */
export interface TestPart {
  index: number;
  count: number;
}

/** Reads `ARCHON_TEST_PART` (`<index>/<count>`); unset means the whole suite. */
export function parseTestPart(value: string | undefined): TestPart | undefined {
  if (value === undefined || value === '') return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = match === null ? Number.NaN : Number(match[1]);
  const count = match === null ? Number.NaN : Number(match[2]);
  if (!(index >= 1 && index <= count)) {
    throw new Error(`ARCHON_TEST_PART must be <index>/<count> with 1 <= index <= count: ${value}`);
  }
  return { index, count };
}

/**
 * Splits groups into `count` parts of about equal measured time, each part's groups slowest
 * first. Every group lands in exactly one part, so the parts together run the whole suite
 * whatever the weights say; stale or missing weights cost only balance. A group is weighed by
 * its first selector, and a group with no recorded weight counts as one second.
 *
 * Slowest first also shortens a single part run with `testConcurrency` above 1: a long group
 * started last would otherwise finish alone after every other worker is idle.
 */
export function partitionTestGroups(
  groups: readonly string[][],
  weights: Readonly<Record<string, number>>,
  count: number
): string[][][] {
  const weightOf = (group: string[]): number => weights[group[0]] ?? 1;
  const ordered = [...groups].sort(
    (a, b) => weightOf(b) - weightOf(a) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const parts = Array.from({ length: count }, () => ({ total: 0, groups: [] as string[][] }));
  for (const group of ordered) {
    const lightest = parts.reduce((min, part) => (part.total < min.total ? part : min));
    lightest.groups.push(group);
    lightest.total += weightOf(group);
  }
  return parts.map(part => part.groups);
}
