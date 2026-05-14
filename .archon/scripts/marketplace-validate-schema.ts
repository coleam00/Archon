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
import { setLogLevel } from '../../packages/paths/src/logger.ts';
import { parseWorkflow } from '../../packages/workflows/src/loader.ts';
import { registerBuiltinProviders, registerCommunityProviders } from '../../packages/providers/src/registry.ts';

// Silence the loader's Pino warnings (workflow_missing_description, etc).
// parseWorkflow logs to stdout by default; the decide node substitutes our
// stdout into a TS expression, so any log noise breaks that parse. The
// loader's child logger is lazy-initialized, so setting the root level
// before the first parseWorkflow call propagates correctly.
setLogLevel('fatal');

// parseWorkflow checks `provider:` against the runtime providers registry.
// The CLI populates it at startup; this standalone script must do the same
// or every workflow with `provider: claude` gets a false-positive
// "Unknown provider" error.
registerBuiltinProviders();
registerCommunityProviders();

/**
 * Decide whether a YAML file is shaped like an Archon workflow definition
 * (top-level `nodes:` block). Marketplace directory submissions commonly
 * include non-workflow YAML like brand.yaml, config.yaml, or template
 * scaffolds — those should not be validated against the workflow schema.
 */
function looksLikeWorkflow(yamlContent: string): boolean {
  return /^nodes\s*:/m.test(yamlContent);
}

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

// Pre-filter to only workflow-shaped YAMLs. Directory submissions commonly
// ship non-workflow YAML alongside the workflow (brand metadata, Archon
// per-repo config, template scaffolds). Validating those as workflows
// produces false-positive errors and tanks legitimate submissions.
const workflowFiles = yamlFiles.filter((p) => looksLikeWorkflow(readFileSync(p, 'utf8')));

if (workflowFiles.length === 0) {
  console.log(JSON.stringify({ valid: true, files: [], note: 'no workflow yaml files (no top-level nodes:)' }));
  process.exit(0);
}

const results: FileResult[] = [];

for (const fullPath of workflowFiles) {
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
