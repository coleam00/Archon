import { relative, isAbsolute, posix } from 'node:path';
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

export function parseTestArguments(requested: string[]) {
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
  return { optionTokens, positionals };
}

export function normalizeTestSelector(packageDirectory: string, value: string): string {
  const selector = (isAbsolute(value) ? relative(packageDirectory, value) : value).replaceAll(
    '\\',
    '/'
  );
  return posix.normalize(selector).replace(/^\.\//, '');
}

export function resolveRequestedTestGroups(
  packageDirectory: string,
  manifest: unknown,
  requested: string[]
) {
  const { optionTokens, positionals } = parseTestArguments(requested);
  const selectors = positionals.map(({ value }) => normalizeTestSelector(packageDirectory, value));
  const inventory = discoverPackageTestFiles(packageDirectory);
  const files = inventory.filter(
    file => selectors.length === 0 || selectors.some(selector => file.includes(selector))
  );
  const validationErrors: Error[] = [];
  const groups = (
    files.length === 0
      ? []
      : resolvePackageTestGroups(packageDirectory, manifest, files, error =>
          validationErrors.push(error)
        )
  )
    .map(group => files.filter(file => group.some(selector => file.includes(selector))))
    .filter(group => group.length > 0);
  const selectorIndices = new Set(positionals.map(token => token.index));
  const options = requested.filter((_, index) => !selectorIndices.has(index));
  return {
    validationErrors,
    allowsNoTests: optionTokens.some(token => token.name === 'pass-with-no-tests'),
    // Let Bun own no-match errors and flags such as --help or --pass-with-no-tests.
    groups:
      groups.length === 0
        ? validationErrors.length > 0
          ? []
          : [requested]
        : groups.map(group => [...options, ...group.map(file => `./${file}`)]),
    namePattern:
      groups.length > 0
        ? optionTokens.filter(token => token.name === 'test-name-pattern').at(-1)?.value
        : undefined,
    reporterOutfile:
      optionTokens.filter(token => token.name === 'reporter').at(-1)?.value === 'junit'
        ? optionTokens.filter(token => token.name === 'reporter-outfile').at(-1)?.value
        : undefined,
  };
}
