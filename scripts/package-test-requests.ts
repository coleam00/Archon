import { relative, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { discoverPackageTestFiles, resolvePackageTestGroups } from './package-test-groups';

// Bun's value-taking test options must not become file selectors. Boolean and
// inline options are forwarded without needing an entry here.
const valueOptions = [
  'timeout',
  'rerun-each',
  'retry',
  'seed',
  'coverage-reporter',
  'coverage-dir',
  'reporter',
  'reporter-outfile',
  'max-concurrency',
  'path-ignore-patterns',
  'parallel-delay',
  'shard',
  'timings',
  'require',
  'import',
  'config',
  'env-file',
  'tsconfig-override',
  'define',
  'loader',
  'conditions',
];

export function resolveRequestedTestGroups(
  packageDirectory: string,
  manifest: unknown,
  requested: string[]
) {
  const { tokens } = parseArgs({
    args: requested,
    strict: false,
    allowPositionals: true,
    tokens: true,
    options: {
      ...Object.fromEntries(valueOptions.map(name => [name, { type: 'string' as const }])),
      'test-name-pattern': { type: 'string', short: 't' },
      preload: { type: 'string', short: 'r' },
    },
  });
  const optionTokens = tokens.filter(token => token.kind === 'option');
  const positionals = tokens
    .filter(token => token.kind === 'positional')
    .filter(token => {
      const previous = optionTokens.find(option => option.index === token.index - 1);
      if (previous?.value !== undefined) return true;
      if (previous?.name === 'changed') return false;
      if (previous?.name === 'bail' || previous?.name === 'parallel') {
        return !Number.isInteger(Number(token.value));
      }
      return true;
    });
  const selectors = positionals.map(({ value }) =>
    (isAbsolute(value) ? relative(packageDirectory, value) : value)
      .replaceAll('\\', '/')
      .replace(/^\.\//, '')
  );
  const inventory = discoverPackageTestFiles(packageDirectory);
  const files = inventory.filter(
    file => selectors.length === 0 || selectors.some(selector => file.includes(selector))
  );
  const groups = resolvePackageTestGroups(packageDirectory, manifest)
    .map(group => files.filter(file => group.some(selector => file.includes(selector))))
    .filter(group => group.length > 0);
  const selectorIndices = new Set(
    positionals
      .filter((_, index) => inventory.some(file => file.includes(selectors[index])))
      .map(token => token.index)
  );
  const options = requested.filter((_, index) => !selectorIndices.has(index));
  return {
    // Let Bun own no-match errors and flags such as --help or --pass-with-no-tests.
    groups:
      groups.length === 0
        ? [requested]
        : groups.map(group => [...options, ...group.map(file => `./${file}`)]),
    filtersNames:
      groups.length > 0 && optionTokens.some(token => token.name === 'test-name-pattern'),
    reporterOutfile: optionTokens.filter(token => token.name === 'reporter-outfile').at(-1)?.value,
  };
}
