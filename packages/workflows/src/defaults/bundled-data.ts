/**
 * Bundled pack records for source builds, read from the indexed pack tree at import.
 *
 * `scripts/build-binaries.sh` overwrites this file with embedded literals from
 * `scripts/generate-bundled-defaults.ts` before `bun build --compile` and restores it
 * afterwards, as it does for `@archon/paths` `bundled-build.ts`. Never commit the
 * literal form: a committed copy of pack content makes every pack change conflict.
 */
import { fileURLToPath } from 'node:url';
import { collectInstalledBundleSources, readBundleRecords } from './bundle-inventory';

// Resolved beside this module rather than through `@archon/paths`: it is the tree the
// binary build embeds, and tests redirect the live bundled root independently.
const records = await readBundleRecords(
  (await collectInstalledBundleSources(
    fileURLToPath(new URL('../../../../.archon/workflows', import.meta.url))
  )) ?? []
);

export const BUNDLED_COMMANDS = records.commands;
export const BUNDLED_WORKFLOWS = records.workflows;
export const BUNDLED_WORKFLOW_PATHS = records.workflowPaths;
export const BUNDLED_WORKFLOW_OWNERS = records.workflowOwners;
export const BUNDLED_SCRIPT_PACKS = records.scriptPacks;
