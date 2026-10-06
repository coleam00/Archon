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
  const discovery = 'testDiscovery' in declaration ? declaration.testDiscovery : undefined;
  if (groups !== undefined && discovery !== undefined) {
    throw new Error('Declare either testGroups or testDiscovery, not both');
  }
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
  if (discovery !== true) throw new Error('Declare nonempty testGroups or testDiscovery: true');

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
  if (files.length === 0) throw new Error('testDiscovery found no tests under src');
  const isolated: string[][] = [];
  const shared: string[] = [];
  for (const file of files) {
    const firstLine = readFileSync(join(packageDirectory, file), 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/, 1)[0];
    if (firstLine === TEST_ISOLATION_DIRECTIVE) isolated.push([file]);
    else shared.push(file);
  }
  return shared.length > 0 ? [...isolated, shared] : isolated;
}
