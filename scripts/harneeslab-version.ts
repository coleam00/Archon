#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type BumpKind = 'major' | 'minor' | 'patch';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPackagePath = join(repoRoot, 'package.json');
const packagesDir = join(repoRoot, 'packages');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageJsonPaths(): string[] {
  const paths = [rootPackagePath];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packagePath = join(packagesDir, entry.name, 'package.json');
    if (existsSync(packagePath)) {
      paths.push(packagePath);
    }
  }

  return paths.sort();
}

function normalizeVersion(input: string): string {
  const version = input.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Invalid version "${input}". Use SemVer like 0.1.0 or 0.2.0-beta.1.`);
  }
  return version;
}

function currentVersion(): string {
  const pkg = readJson(rootPackagePath);
  if (typeof pkg.version !== 'string') {
    fail('Root package.json is missing a version string.');
  }
  return normalizeVersion(pkg.version);
}

function nextVersion(kind: BumpKind): string {
  const current = currentVersion();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    fail(`Cannot bump prerelease version "${current}". Use "set <version>" instead.`);
  }

  const [, majorRaw, minorRaw, patchRaw] = match;
  let major = Number(majorRaw);
  let minor = Number(minorRaw);
  let patch = Number(patchRaw);

  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

function setVersion(version: string): string {
  const normalized = normalizeVersion(version);

  for (const packagePath of packageJsonPaths()) {
    const pkg = readJson(packagePath);
    pkg.version = normalized;
    writeJson(packagePath, pkg);
  }

  return normalized;
}

function parseBumpKind(value = 'patch'): BumpKind {
  if (value === 'major' || value === 'minor' || value === 'patch') {
    return value;
  }
  fail(`Invalid bump "${value}". Use major, minor, or patch.`);
}

function printHelp(): void {
  console.log(`HarneesLab version helper

Usage:
  bun scripts/harneeslab-version.ts current
  bun scripts/harneeslab-version.ts next [major|minor|patch]
  bun scripts/harneeslab-version.ts bump [major|minor|patch]
  bun scripts/harneeslab-version.ts set <version>
  bun scripts/harneeslab-version.ts tag [version]

Notes:
  - HarneesLab uses an independent SemVer line starting at 0.1.0.
  - Root package.json is the source of truth.
  - bump/set sync all packages/*/package.json versions.`);
}

const [command = 'current', value] = process.argv.slice(2);

if (command === 'current') {
  console.log(currentVersion());
} else if (command === 'next') {
  console.log(nextVersion(parseBumpKind(value)));
} else if (command === 'bump') {
  console.log(setVersion(nextVersion(parseBumpKind(value))));
} else if (command === 'set') {
  if (!value) {
    fail('Missing version. Example: bun scripts/harneeslab-version.ts set 0.1.0');
  }
  console.log(setVersion(value));
} else if (command === 'tag') {
  console.log(`v${normalizeVersion(value ?? currentVersion())}`);
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  fail(`Unknown command "${command}". Run with --help.`);
}
