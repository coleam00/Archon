#!/usr/bin/env bun
/**
 * Deterministic security scanner for marketplace submission source files.
 * Reads all files from $ARTIFACTS_DIR/source/ recursively and checks against
 * 9 pattern categories. Exits 0 regardless of findings (caller decides threshold).
 * Output: JSON to stdout with severity + findings array.
 *
 * Thin CLI wrapper: reads files off disk, then delegates the actual scan to
 * `scanMarketplaceFilesForSecurityIssues` (packages/workflows/src/marketplace-checks.ts)
 * — the SAME function `preflight.ts` calls in-process for the Marketplace
 * Submission flow's pre-flight gate, so there is zero drift between what CI
 * enforces here and what a Submit blocks on before any write.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { scanMarketplaceFilesForSecurityIssues } from '../../packages/workflows/src/marketplace-checks.ts';

function findAllFiles(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...findAllFiles(full, base));
    } else {
      found.push(full);
    }
  }
  return found;
}

const artifactsDir = process.env['ARTIFACTS_DIR'] ?? '';
if (!artifactsDir) {
  process.stderr.write('ARTIFACTS_DIR env var is required\n');
  process.exit(1);
}

const sourceDir = resolve(artifactsDir, 'source');
const files = existsSync(sourceDir)
  ? findAllFiles(sourceDir, sourceDir).map(fullPath => ({
      name: relative(sourceDir, fullPath),
      content: readFileSync(fullPath, 'utf8'),
    }))
  : [];

const result = scanMarketplaceFilesForSecurityIssues(files);
console.log(JSON.stringify(result, null, 2));
