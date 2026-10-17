import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { collectBundleSources, readBundleRecords } from './defaults/bundle-inventory';

/**
 * Writes `files` (paths relative to a bundled workflows root) under `root` and returns
 * the `bundled-defaults` record exports for `packs`, read through the same inventory the
 * binary build embeds. Tests mock `./defaults/bundled-defaults` with these records, and
 * point `getBundledWorkflowsPath` at `root` for source mode, so engine tests never use
 * the shipped pack as a fixture.
 */
export async function writeFakeBundle(
  root: string,
  files: Readonly<Record<string, string>>,
  packs: readonly string[]
) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const records = await readBundleRecords(await collectBundleSources(root, packs));
  return {
    BUNDLED_COMMANDS: records.commands,
    BUNDLED_WORKFLOWS: records.workflows,
    BUNDLED_WORKFLOW_PATHS: records.workflowPaths,
    BUNDLED_WORKFLOW_OWNERS: records.workflowOwners,
    BUNDLED_SCRIPT_PACKS: records.scriptPacks,
  };
}
