import { access } from 'fs/promises';
import { join } from 'path';
import { PLUGIN_MANIFEST_FILE } from '@archon/plugin-manifest';
import { MAX_DISCOVERY_DEPTH } from './command-validation';
import { FIXTURES_DIR } from './fixture-layout';

export async function isWorkflowSubdirectory(
  entryPath: string,
  entry: string,
  depth: number
): Promise<boolean> {
  if (entry === FIXTURES_DIR || depth >= MAX_DISCOVERY_DEPTH) return false;
  // Copied pack roots belong to the pack loader; their root YAML files are examples.
  try {
    await access(join(entryPath, PLUGIN_MANIFEST_FILE));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
