/** Where a host process (the CLI or `archon serve`) finds forge plugins and their config. */
import { readFile } from 'node:fs/promises';
import { BUNDLED_IS_BINARY } from '@archon/paths';
import { getSourceGithubForgeEntry } from '@archon/paths/source-tree-paths';
import type { SourcePlugin } from './discovery';

/** The `forge:` block of an Archon config file; empty when the file or the block is absent. */
export async function readForgeConfig(configPath: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const config: unknown = Bun.YAML.parse(source);
  if (config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config))
    throw new Error('Archon config must be an object');
  return 'forge' in config ? config.forge : {};
}

/**
 * Release binaries carry no forge plugin and load only installed executables. Source
 * checkouts and Docker run the GitHub plugin from this checkout, as they run the
 * maintained providers, so the plugin is never older than the host that calls it.
 */
export function sourceForgePlugins(isBinary: boolean = BUNDLED_IS_BINARY): SourcePlugin[] {
  if (isBinary) return [];
  return [
    {
      name: 'github',
      command: process.execPath,
      args: ['--no-env-file', getSourceGithubForgeEntry()],
    },
  ];
}
