#!/usr/bin/env bun
/**
 * Writes packages/workflows/src/defaults/bundled-data.ts as embedded string literals for
 * the compiled binary. scripts/build-binaries.sh runs it before `bun build --compile` and
 * restores the committed, source-reading module afterwards. Running it by hand overwrites
 * that module; restore it with `git checkout`.
 *
 * bundle-inventory.ts owns file selection and the records, so the binary embeds exactly
 * what a source build reads. Contents are inlined via JSON.stringify rather than Bun's
 * `with { type: 'text' }` import attributes, which Node cannot load.
 *
 * Exit codes:
 *   0  file written
 *   1  unexpected error (missing dir, unreadable or untracked source, invalid filename, etc.)
 */
import { writeFile } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { execFileAsync } from '@archon/git';
import {
  type BundleRecords,
  collectBundleSources,
  readBundleIndex,
  readBundleRecords,
} from '../packages/workflows/src/defaults/bundle-inventory';

// BUNDLED_DEFAULTS_REPO_ROOT is a test seam: the integration tests point the
// script at a throwaway git repo (see
// packages/workflows/src/defaults/generate-bundled-defaults.test.ts).
const REPO_ROOT = process.env.BUNDLED_DEFAULTS_REPO_ROOT
  ? resolve(process.env.BUNDLED_DEFAULTS_REPO_ROOT)
  : resolve(import.meta.dir, '..');
const WORKFLOWS_ROOT_REL = '.archon/workflows';
const WORKFLOWS_ROOT = join(REPO_ROOT, WORKFLOWS_ROOT_REL);
const OUTPUT_PATH = join(REPO_ROOT, 'packages/workflows/src/defaults/bundled-data.ts');

/** Refuse to embed files that git does not track (#1578). An untracked selected file would
 * silently ship inside locally built binaries while being absent from every other checkout
 * and from CI builds — fail loudly instead. */
async function assertTrackedPackagedFiles(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const relativePaths = paths.map(path => relative(REPO_ROOT, path).replaceAll('\\', '/'));
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--', ...relativePaths],
    { cwd: REPO_ROOT }
  );
  const tracked = new Set(stdout.trim().split('\n').filter(Boolean));
  const missing = relativePaths.filter(path => !tracked.has(path));
  if (missing.length > 0) {
    throw new Error(
      `Packaged workflows contain untracked files that would be embedded into the binary bundle:\n${missing
        .map(path => `  ${path}`)
        .join('\n')}\n\nStage and commit them, or remove them from the packaged workflow folder.`
    );
  }
}

function renderFile(records: BundleRecords): string {
  return `/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Written by scripts/build-binaries.sh for the compiled binary; never committed.
 * Source of truth: bundle-index.json selects packs; bundle-inventory.ts selects files.
 */

import type { BundledWorkflowOwner } from './bundle-inventory';
import type { BundledScriptPack } from './bundled-script-pack';

export const BUNDLED_COMMANDS: Record<string, string> = ${JSON.stringify(records.commands)};
export const BUNDLED_WORKFLOWS: Record<string, string> = ${JSON.stringify(records.workflows)};
export const BUNDLED_WORKFLOW_PATHS: Record<string, string> = ${JSON.stringify(records.workflowPaths)};
export const BUNDLED_WORKFLOW_OWNERS: Readonly<Partial<Record<keyof typeof BUNDLED_WORKFLOWS, BundledWorkflowOwner>>> = ${JSON.stringify(records.workflowOwners)};
export const BUNDLED_SCRIPT_PACKS: Record<string, BundledScriptPack> = ${JSON.stringify(records.scriptPacks)};
`;
}

async function main(): Promise<void> {
  const packs = await readBundleIndex(
    join(REPO_ROOT, 'packages/workflows/src/defaults/bundle-index.json')
  );
  const files = await collectBundleSources(WORKFLOWS_ROOT, packs);
  await assertTrackedPackagedFiles(files.map(file => file.sourcePath));
  const records = await readBundleRecords(files);
  await writeFile(OUTPUT_PATH, renderFile(records), 'utf-8');
  console.log(
    `Wrote ${OUTPUT_PATH}\n  ${Object.keys(records.commands).length} commands, ${Object.keys(records.workflows).length} workflows, ${Object.keys(records.scriptPacks).length} script packs.`
  );
}
main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
