import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every declaration of the Bun runtime version in the repository must agree.
 * This includes every workflow file's BUN_VERSION env var, package.json
 * engines.bun, and the Dockerfile base image. A hand-synced pair between any
 * of these is a present defect — this test is the mechanism that catches drift.
 */
describe('Bun version consistency', () => {
  const root = resolve(import.meta.dir, '..');
  const workflowDir = resolve(root, '.github/workflows');

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    engines?: { bun?: string };
  };
  const expected = pkg.engines?.bun;
  if (!expected) throw new Error('package.json engines.bun is missing');

  test('every workflow that declares BUN_VERSION agrees with package.json engines.bun', () => {
    const yamlFiles = readdirSync(workflowDir).filter(f => f.endsWith('.yml'));

    const declarations: { file: string; version: string }[] = [];
    for (const file of yamlFiles) {
      const content = readFileSync(resolve(workflowDir, file), 'utf8');
      // Match both quoted and unquoted env values: BUN_VERSION: '1.4.0' and BUN_VERSION: 1.4.0
      const match = content.match(/^\s*BUN_VERSION:\s*['"]?([^'"\s]+)['"]?\s*$/m);
      if (!match) continue;
      declarations.push({ file, version: match[1] });
    }

    // At least one workflow must declare the version (if none do, no workflow
    // uses Bun — unlikely but the test should be loud about it).
    expect(declarations.length).toBeGreaterThan(0);

    const mismatches = declarations
      .filter(d => d.version !== expected)
      .map(d => `${d.file}: BUN_VERSION=${d.version} (expected ${expected})`);

    expect(mismatches).toEqual([]);
  });

  test('Dockerfile base image version agrees with package.json engines.bun', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');

    // Extract the ARG BUN_VERSION default value and the FROM references
    const argMatch = dockerfile.match(/^ARG BUN_VERSION=(\S+)/m);
    expect(argMatch).not.toBeNull();
    const argVersion = argMatch![1];

    // Every FROM oven/bun:... must use the ARG, not a literal version
    const fromLines = [...dockerfile.matchAll(/^FROM oven\/bun:(\S+)/gm)];
    expect(fromLines.length).toBeGreaterThan(0);

    for (const match of fromLines) {
      const imageTag = match[1];
      // The image tag must either reference the ARG or match the expected version
      if (imageTag === '${BUN_VERSION}-slim') continue;
      expect(imageTag).toBe(`${expected}-slim`);
    }

    expect(argVersion).toBe(expected);
  });
});
