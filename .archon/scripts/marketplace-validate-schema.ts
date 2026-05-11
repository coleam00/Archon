#!/usr/bin/env bun
/**
 * Validates all .yaml files in $ARTIFACTS_DIR/source/ against the Archon workflow schema.
 * Output: JSON to stdout: { valid: boolean, files: FileResult[] }
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
// Resolve workspace package via relative path: Bun's run-script context for
// .archon/scripts/ doesn't reliably honor the @archon/workflows/loader subpath
// export in CI. Direct file import avoids the resolution gap.
import { parseWorkflow } from '../../packages/workflows/src/loader.ts';

interface FileResult {
  name: string;
  valid: boolean;
  errors: string[];
}

const artifactsDir = process.env['ARTIFACTS_DIR'] ?? '';
if (!artifactsDir) {
  process.stderr.write('ARTIFACTS_DIR env var is required\n');
  process.exit(1);
}

const sourceDir = resolve(artifactsDir, 'source');
if (!existsSync(sourceDir)) {
  console.log(JSON.stringify({ valid: true, files: [], note: 'no source directory' }));
  process.exit(0);
}

function findYamlFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findYamlFiles(full));
    } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
      found.push(full);
    }
  }
  return found;
}

const yamlFiles = findYamlFiles(sourceDir);

if (yamlFiles.length === 0) {
  console.log(JSON.stringify({ valid: true, files: [], note: 'no yaml files found' }));
  process.exit(0);
}

const results: FileResult[] = [];

for (const fullPath of yamlFiles) {
  const relName = relative(sourceDir, fullPath);
  const content = readFileSync(fullPath, 'utf8');
  const result = parseWorkflow(content, relName);
  if (result.workflow === null) {
    results.push({ name: relName, valid: false, errors: [result.error.error] });
  } else {
    results.push({ name: relName, valid: true, errors: [] });
  }
}

const allValid = results.every((r) => r.valid);
console.log(JSON.stringify({ valid: allValid, files: results }));
// Always exit 0 — the decide node reads `valid` from the JSON output and
// routes to `request_changes` if false. Exit 1 here would crash the DAG
// before decide/act can post a useful review comment to the PR.
process.exit(0);
