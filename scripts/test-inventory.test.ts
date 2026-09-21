/**
 * Package test scripts deliberately split Bun invocations because `mock.module()`
 * state is process-global and irreversible. That makes each package manifest the
 * test inventory, so a new file can otherwise remain invisible forever.
 *
 * A package declares those groups one of two ways: a `bun test ... && bun test ...`
 * chain in `scripts.test`, or a `testGroups` array that `scripts/package-tests.ts`
 * runs. Both are read here. Half-adopting either is rejected: `testGroups` without the
 * runner is an inventory nothing executes, and the runner without `testGroups` executes
 * nothing this guard can see.
 *
 * Keep the batches explicit. The package-script guard below verifies that every
 * TypeScript test is selected by a file or directory argument and that selected
 * paths still exist. The repository guard combines those selectors with the root
 * test plan and workspace declaration so tracked tests cannot sit outside every
 * command. The compiler guard separately protects normal package projects from
 * excluding their tests again. `bun run test` discovers all three because the root
 * plan tests `./scripts/` directly.
 */
import { describe, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT_TEST_PLAN } from './repo-tests';

interface InventoryMismatch {
  packageName: string;
  manifestPath: string;
  missingTests: string[];
  staleSelectors: string[];
  unsupportedDeclarations: string[];
}

interface SelectorParseResult {
  selectors: string[];
  unsupportedDeclarations: string[];
}

const REPO_ROOT = join(import.meta.dir, '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
/** Every workspace sits at `packages/<name>`, so the runner path is the same for all of them. */
const PACKAGE_TEST_RUNNER = 'bun run ../../scripts/package-tests.ts';
/** The root script must be the runner that walks `ROOT_TEST_PLAN`, or this guard reads a plan nothing executes. */
const ROOT_TEST_RUNNER = 'bun run scripts/repo-tests.ts';
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/;
const TRACKED_TEST_PATTERNS = ['*.test.ts', '*.spec.ts', '*.test.tsx', '*.spec.tsx'];

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): string[] => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

function readPackageManifest(manifestPath: string): {
  name: string | undefined;
  testScript: string | undefined;
  testGroups: string[][] | undefined;
  workspaces: string[] | undefined;
} {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${normalizePath(relative(REPO_ROOT, manifestPath))} is not a JSON object`);
  }

  const scripts = isRecord(parsed.scripts) ? parsed.scripts : undefined;
  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    testScript: typeof scripts?.test === 'string' ? scripts.test : undefined,
    testGroups:
      Array.isArray(parsed.testGroups) &&
      parsed.testGroups.every(
        (group): boolean => Array.isArray(group) && group.every(entry => typeof entry === 'string')
      )
        ? (parsed.testGroups as string[][])
        : undefined,
    workspaces:
      Array.isArray(parsed.workspaces) &&
      parsed.workspaces.every(value => typeof value === 'string')
        ? parsed.workspaces
        : undefined,
  };
}

function readRootWorkspaces(): string[] {
  const manifest = readPackageManifest(join(REPO_ROOT, 'package.json'));
  if (manifest.testScript?.trim() !== ROOT_TEST_RUNNER) {
    throw new Error(
      `The root package.json must set scripts.test to "${ROOT_TEST_RUNNER}" so ROOT_TEST_PLAN is what runs`
    );
  }
  if (manifest.workspaces === undefined) {
    throw new Error('The root package.json does not define string-array workspaces');
  }
  return manifest.workspaces;
}

function sourceSelectors(testScript: string | undefined): SelectorParseResult {
  if (testScript === undefined) return { selectors: [], unsupportedDeclarations: [] };

  const selectors: string[] = [];
  const unsupportedDeclarations: string[] = [];
  for (const command of testScript.split('&&')) {
    const trimmedCommand = command.trim();
    const tokens = trimmedCommand.split(/\s+/);
    if (tokens[0] !== 'bun' || tokens[1] !== 'test') {
      unsupportedDeclarations.push(trimmedCommand);
      continue;
    }

    const args = tokens.slice(2);
    const firstUnsupported = args.findIndex((token): boolean => !token.startsWith('src/'));
    const supportedSelectors = firstUnsupported === -1 ? args : args.slice(0, firstUnsupported);
    selectors.push(...supportedSelectors);

    if (args.length === 0 || firstUnsupported !== -1) {
      unsupportedDeclarations.push(trimmedCommand);
    }
  }

  return {
    selectors: selectors.sort(),
    unsupportedDeclarations,
  };
}

function groupSelectors(groups: string[][]): SelectorParseResult {
  const selectors: string[] = [];
  const unsupportedDeclarations: string[] = [];

  if (groups.length === 0) unsupportedDeclarations.push('testGroups is empty');

  for (const [index, group] of groups.entries()) {
    if (group.length === 0) {
      unsupportedDeclarations.push(`testGroups[${String(index)}] is empty`);
      continue;
    }
    for (const selector of group) {
      // Mirrors the `src/` rule the script form applies, so both declarations describe
      // the same inventory and a package can move between them without changing meaning.
      if (selector.startsWith('src/')) selectors.push(selector);
      else unsupportedDeclarations.push(`testGroups[${String(index)}] selector "${selector}"`);
    }
  }

  return { selectors: selectors.sort(), unsupportedDeclarations };
}

/**
 * Resolves a package's test inventory from whichever declaration form it uses, and
 * rejects a package that adopted only half of the `testGroups` form.
 */
function packageTestSelectors(manifest: {
  testScript: string | undefined;
  testGroups: string[][] | undefined;
}): SelectorParseResult {
  const runsSharedRunner = manifest.testScript?.trim() === PACKAGE_TEST_RUNNER;

  if (manifest.testGroups !== undefined) {
    return runsSharedRunner
      ? groupSelectors(manifest.testGroups)
      : {
          selectors: [],
          unsupportedDeclarations: [
            `declares testGroups but scripts.test is not "${PACKAGE_TEST_RUNNER}"`,
          ],
        };
  }

  if (runsSharedRunner) {
    return {
      selectors: [],
      unsupportedDeclarations: [`runs "${PACKAGE_TEST_RUNNER}" without a string-array testGroups`],
    };
  }

  return sourceSelectors(manifest.testScript);
}

/** Paths the root plan tests itself, rather than delegating to a workspace. */
const ROOT_TEST_SELECTORS = ROOT_TEST_PLAN.flatMap((step): string[] =>
  step.kind === 'root' ? step.selectors : []
);
const ROOT_PLAN_RUNS_WORKSPACE_TESTS = ROOT_TEST_PLAN.some(
  (step): boolean => step.kind === 'workspaces'
);

function selectorCollects(selector: string, testPath: string, baseDirectory: string): boolean {
  const selectorPath = normalizePath(
    relative(REPO_ROOT, resolve(baseDirectory, selector.replace(/^\.\//, '')))
  ).replace(/\/$/, '');
  return testPath === selectorPath || testPath.startsWith(`${selectorPath}/`);
}

function trackedTests(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '--', ...TRACKED_TEST_PATTERNS], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not list tracked tests:\n${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split('\0')
    .filter((path): boolean => path.length > 0)
    .map(normalizePath)
    .sort();
}

function matchesWorkspacePattern(directory: string, pattern: string): boolean {
  const directorySegments = normalizePath(directory).split('/');
  const patternSegments = normalizePath(pattern).replace(/^\.\//, '').split('/');
  return (
    directorySegments.length === patternSegments.length &&
    patternSegments.every(
      (segment, index): boolean => segment === '*' || segment === directorySegments[index]
    )
  );
}

function packageDirectoryForTest(
  testPath: string,
  workspacePatterns: string[]
): string | undefined {
  const [directory, packageName] = testPath.split('/');
  if (directory !== 'packages' || packageName === undefined) return undefined;

  const workspaceDirectory = `${directory}/${packageName}`;
  if (!workspacePatterns.some(pattern => matchesWorkspacePattern(workspaceDirectory, pattern))) {
    return undefined;
  }

  const packageDirectory = join(PACKAGES_DIR, packageName);
  return existsSync(join(packageDirectory, 'package.json')) ? packageDirectory : undefined;
}

function isCollectedByRepositoryTest(
  testPath: string,
  rootSelectors: string[],
  workspacePatterns: string[],
  workspaceTestsRun: boolean
): boolean {
  if (rootSelectors.some((selector): boolean => selectorCollects(selector, testPath, REPO_ROOT))) {
    return true;
  }
  if (!workspaceTestsRun) return false;

  const packageDirectory = packageDirectoryForTest(testPath, workspacePatterns);
  if (packageDirectory === undefined) return false;

  const manifest = readPackageManifest(join(packageDirectory, 'package.json'));
  return packageTestSelectors(manifest).selectors.some((selector): boolean =>
    selectorCollects(selector, testPath, packageDirectory)
  );
}

function inspectPackage(packageDirectory: string): InventoryMismatch | undefined {
  const manifestPath = join(packageDirectory, 'package.json');
  const sourceDirectory = join(packageDirectory, 'src');
  if (!existsSync(manifestPath)) return undefined;

  const tests = existsSync(sourceDirectory)
    ? listFiles(sourceDirectory)
        .filter((path): boolean => TEST_FILE_PATTERN.test(path))
        .map((path): string => normalizePath(relative(packageDirectory, path)))
    : [];

  const manifest = readPackageManifest(manifestPath);
  const { selectors, unsupportedDeclarations } = packageTestSelectors(manifest);
  const selectedTests = new Set<string>();
  const staleSelectors: string[] = [];

  for (const selector of selectors) {
    const absoluteSelector = resolve(packageDirectory, selector);
    if (!existsSync(absoluteSelector)) {
      staleSelectors.push(selector);
      continue;
    }

    if (statSync(absoluteSelector).isDirectory()) {
      const directoryPrefix = `${normalizePath(relative(packageDirectory, absoluteSelector))}/`;
      for (const testPath of tests) {
        if (testPath.startsWith(directoryPrefix)) selectedTests.add(testPath);
      }
    } else if (TEST_FILE_PATTERN.test(selector)) {
      selectedTests.add(normalizePath(selector));
    }
  }

  const missingTests = tests.filter((path): boolean => !selectedTests.has(path));
  if (
    missingTests.length === 0 &&
    staleSelectors.length === 0 &&
    unsupportedDeclarations.length === 0
  ) {
    return undefined;
  }

  return {
    packageName: manifest.name ?? relative(PACKAGES_DIR, packageDirectory),
    manifestPath: normalizePath(relative(REPO_ROOT, manifestPath)),
    missingTests,
    staleSelectors,
    unsupportedDeclarations,
  };
}

function formatMismatches(mismatches: InventoryMismatch[]): string {
  const details = mismatches.flatMap((mismatch): string[] => {
    const lines = [`${mismatch.packageName} (${mismatch.manifestPath})`];
    if (mismatch.missingTests.length > 0) {
      lines.push('  Tests missing from scripts.test:');
      lines.push(...mismatch.missingTests.map((path): string => `    - ${path}`));
    }
    if (mismatch.staleSelectors.length > 0) {
      lines.push('  selectors that do not exist:');
      lines.push(...mismatch.staleSelectors.map((path): string => `    - ${path}`));
    }
    if (mismatch.unsupportedDeclarations.length > 0) {
      lines.push('  test declarations this inventory cannot read:');
      lines.push(...mismatch.unsupportedDeclarations.map((entry): string => `    - ${entry}`));
    }
    return lines;
  });

  return [
    'Package test inventory is out of sync.',
    ...details,
    'Add each test to a compatible Bun batch or cover it with a directory selector; remove stale selectors.',
    `Declare package tests either as an explicit \`bun test <src selectors>\` chain in scripts.test, or as a testGroups array with scripts.test set to "${PACKAGE_TEST_RUNNER}", so execution and inventory agree.`,
    'Keep separate `bun test` invocations where `mock.module()` factories conflict.',
  ].join('\n');
}

describe('package test inventory', () => {
  test('every TypeScript test is selected by its package test script', () => {
    const mismatches = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((entry): boolean => entry.isDirectory())
      .sort((left, right): number => left.name.localeCompare(right.name))
      .map((entry): InventoryMismatch | undefined => inspectPackage(join(PACKAGES_DIR, entry.name)))
      .filter((mismatch): mismatch is InventoryMismatch => mismatch !== undefined);

    if (mismatches.length > 0) throw new Error(formatMismatches(mismatches));
  });
});

describe('repository test inventory', () => {
  test('every tracked TypeScript test is selected by bun run test', () => {
    const workspaces = readRootWorkspaces();
    const uncollectedTests = trackedTests().filter(
      (testPath): boolean =>
        !isCollectedByRepositoryTest(
          testPath,
          ROOT_TEST_SELECTORS,
          workspaces,
          ROOT_PLAN_RUNS_WORKSPACE_TESTS
        )
    );

    if (uncollectedTests.length > 0) {
      throw new Error(
        [
          'Tracked TypeScript tests are not collected by bun run test:',
          ...uncollectedTests.map((path): string => `  - ${path}`),
          'Add each path to a repository test command.',
        ].join('\n')
      );
    }
  });
});

describe('compiler test inventory', () => {
  async function expectProgramToInclude(
    packageName: string,
    expectedFiles: string[]
  ): Promise<void> {
    const projectPath = join(REPO_ROOT, 'packages', packageName, 'tsconfig.json');
    const process = Bun.spawn(
      ['bun', 'x', 'tsc', '--noEmit', '--listFilesOnly', '--project', projectPath],
      { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(`Could not list the ${packageName} TypeScript program:\n${stderr}`);
    }

    const programFiles = new Set(stdout.split(/\r?\n/).map(normalizePath));
    const missingFiles = expectedFiles.filter(
      (expectedFile): boolean => !programFiles.has(normalizePath(expectedFile))
    );

    if (missingFiles.length > 0) {
      throw new Error(
        `The normal ${packageName} TypeScript project did not include:\n${missingFiles.join('\n')}`
      );
    }
  }

  test("core's normal TypeScript project includes test files", () => {
    return expectProgramToInclude('core', [
      join(REPO_ROOT, 'packages', 'core', 'src', 'utils', 'conversation-lock.test.ts'),
    ]);
  }, 15_000);

  test("adapters' normal TypeScript project includes its own and imported core test files", () => {
    return expectProgramToInclude('adapters', [
      join(REPO_ROOT, 'packages', 'adapters', 'src', 'forge', 'github', 'adapter.test.ts'),
      join(REPO_ROOT, 'packages', 'core', 'src', 'utils', 'conversation-lock.test.ts'),
    ]);
  }, 15_000);

  test("server's normal TypeScript project includes its own, core, and adapter test files", () => {
    return expectProgramToInclude('server', [
      join(REPO_ROOT, 'packages', 'server', 'src', 'routes', 'api.health.test.ts'),
      join(REPO_ROOT, 'packages', 'core', 'src', 'utils', 'conversation-lock.test.ts'),
      join(REPO_ROOT, 'packages', 'adapters', 'src', 'forge', 'github', 'adapter.test.ts'),
    ]);
  }, 15_000);

  test("cli's normal TypeScript project includes its own, core, adapter, and server test files", () => {
    return expectProgramToInclude('cli', [
      join(REPO_ROOT, 'packages', 'cli', 'src', 'cli.test.ts'),
      join(REPO_ROOT, 'packages', 'core', 'src', 'utils', 'conversation-lock.test.ts'),
      join(REPO_ROOT, 'packages', 'adapters', 'src', 'forge', 'github', 'adapter.test.ts'),
      join(REPO_ROOT, 'packages', 'server', 'src', 'routes', 'api.health.test.ts'),
    ]);
  }, 15_000);
});
