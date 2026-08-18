/**
 * Package test scripts deliberately split Bun invocations because `mock.module()`
 * state is process-global and irreversible. That makes each package manifest the
 * test inventory, so a new file can otherwise remain invisible forever.
 *
 * Keep the batches explicit. This repository-level guard only verifies that every
 * TypeScript test is selected by a file or directory argument, and that selected
 * paths still exist. `bun run test` discovers this file through its final
 * `bun test ./scripts/` invocation.
 */
import { describe, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface InventoryMismatch {
  packageName: string;
  manifestPath: string;
  missingTests: string[];
  staleSelectors: string[];
  unsupportedCommands: string[];
}

interface SelectorParseResult {
  selectors: string[];
  unsupportedCommands: string[];
}

const REPO_ROOT = join(import.meta.dir, '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

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
} {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${normalizePath(relative(REPO_ROOT, manifestPath))} is not a JSON object`);
  }

  const scripts = isRecord(parsed.scripts) ? parsed.scripts : undefined;
  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    testScript: typeof scripts?.test === 'string' ? scripts.test : undefined,
  };
}

function sourceSelectors(testScript: string | undefined): SelectorParseResult {
  if (testScript === undefined) return { selectors: [], unsupportedCommands: [] };

  const selectors: string[] = [];
  const unsupportedCommands: string[] = [];
  for (const command of testScript.split('&&')) {
    const trimmedCommand = command.trim();
    const tokens = trimmedCommand.split(/\s+/);
    if (tokens[0] !== 'bun' || tokens[1] !== 'test') {
      unsupportedCommands.push(trimmedCommand);
      continue;
    }

    const args = tokens.slice(2);
    const firstUnsupported = args.findIndex((token): boolean => !token.startsWith('src/'));
    const supportedSelectors = firstUnsupported === -1 ? args : args.slice(0, firstUnsupported);
    selectors.push(...supportedSelectors);

    if (args.length === 0 || firstUnsupported !== -1) {
      unsupportedCommands.push(trimmedCommand);
    }
  }

  return {
    selectors: selectors.sort(),
    unsupportedCommands,
  };
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
  const { selectors, unsupportedCommands } = sourceSelectors(manifest.testScript);
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
    unsupportedCommands.length === 0
  ) {
    return undefined;
  }

  return {
    packageName: manifest.name ?? relative(PACKAGES_DIR, packageDirectory),
    manifestPath: normalizePath(relative(REPO_ROOT, manifestPath)),
    missingTests,
    staleSelectors,
    unsupportedCommands,
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
      lines.push('  scripts.test selectors that do not exist:');
      lines.push(...mismatch.staleSelectors.map((path): string => `    - ${path}`));
    }
    if (mismatch.unsupportedCommands.length > 0) {
      lines.push('  scripts.test commands outside the supported `bun test <src selectors>` form:');
      lines.push(...mismatch.unsupportedCommands.map((command): string => `    - ${command}`));
    }
    return lines;
  });

  return [
    'Package test inventory is out of sync.',
    ...details,
    'Add each test to a compatible Bun batch or cover it with a directory selector; remove stale selectors.',
    'Keep package test commands in the explicit `bun test <src selectors>` form so execution and inventory agree.',
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
