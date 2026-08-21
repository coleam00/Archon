#!/usr/bin/env bun
/**
 * Validates all .yaml files in $ARTIFACTS_DIR/source/ against the Archon workflow schema.
 * Output: JSON to stdout: { valid: boolean, files: FileResult[] }
 *
 * Thin CLI wrapper: reads files off disk, then delegates the actual schema
 * check to `validateMarketplaceWorkflowFiles` (packages/workflows/src/marketplace-checks.ts)
 * — the SAME function `preflight.ts` calls in-process for the Marketplace
 * Submission flow's pre-flight gate, so there is zero drift between what CI
 * enforces here and what a Submit blocks on before any write.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
// Resolve workspace package via relative path: Bun's run-script context for
// .archon/scripts/ doesn't reliably honor the @archon/workflows/loader subpath
// export in CI. Direct file import avoids the resolution gap.
import { setLogLevel } from '../../packages/paths/src/logger.ts';
import { registerBuiltinProviders, registerCommunityProviders } from '../../packages/providers/src/registry.ts';
import { validateMarketplaceWorkflowFiles } from '../../packages/workflows/src/marketplace-checks.ts';

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

const yamlFiles = findYamlFiles(sourceDir).map(fullPath => ({
  name: relative(sourceDir, fullPath),
  content: readFileSync(fullPath, 'utf8'),
}));

const result = validateMarketplaceWorkflowFiles(yamlFiles);
// JSON.stringify omits the `note` key entirely when it's undefined (the
// "real results" case), matching the original script's exact output shape.
console.log(JSON.stringify(result));
// Always exit 0 — the decide node reads `valid` from the JSON output and
// routes to `request_changes` if false. Exit 1 here would crash the DAG
// before decide/act can post a useful review comment to the PR.
process.exit(0);
