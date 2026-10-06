import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TEST_ISOLATION_DIRECTIVE = '// @archon-test-isolated';

export function resolvePackageTestGroups(
  packageDirectory: string,
  declaration: unknown
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

  const files = [
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
    throw new Error(
      `These tests call mock.module() but do not start with "${TEST_ISOLATION_DIRECTIVE}": ${unmarkedMocks.join(', ')}`
    );
  }
  return shared.length > 0 ? [...isolated, shared] : isolated;
}
