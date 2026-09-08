import { readdir, stat } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { getArchonHome } from '@archon/paths/archon-paths';
import type { PluginCandidate } from './exec';
export type { ForgeHostsConfig } from '../schemas';
export type DiscoveryDiagnostic = (reason: string) => void;
async function discoverInDir(
  dir: string,
  source: string,
  diagnostic: DiscoveryDiagnostic
): Promise<PluginCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      diagnostic(`${source}: cannot read plugin directory`);
    return [];
  }
  const found: PluginCandidate[] = [];
  for (const entry of entries.sort()) {
    if (!/^archon-forge-[a-z0-9-]+(?:\.(?:exe|cmd|bat))?$/i.test(entry)) continue;
    const full = resolve(dir, entry);
    if (process.platform === 'win32' && !entry.toLowerCase().endsWith('.exe')) {
      diagnostic(`${source}: refused ${entry}: Windows plugins require .exe`);
      continue;
    }
    const info = await stat(full);
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o111) === 0)) {
      diagnostic(`${source}: refused ${entry}: not an executable file`);
      continue;
    }
    const name = entry
      .replace(/^archon-forge-/i, '')
      .replace(/\.exe$/i, '')
      .toLowerCase();
    found.push({ source: `${source}:${name}`, command: full, args: [] });
  }
  return found;
}
export function pluginsDir(): string {
  return join(getArchonHome(), 'plugins');
}
export async function discoverHomePlugins(
  diagnostic: DiscoveryDiagnostic = console.error
): Promise<PluginCandidate[]> {
  return discoverInDir(pluginsDir(), '~/.archon/plugins', diagnostic);
}
export async function discoverPathPlugins(
  pathEnv: string | undefined = process.env.PATH,
  diagnostic: DiscoveryDiagnostic = console.error
): Promise<PluginCandidate[]> {
  const found: PluginCandidate[] = [];
  for (const dir of new Set((pathEnv ?? '').split(delimiter).filter(Boolean))) {
    found.push(...(await discoverInDir(dir, 'PATH', diagnostic)));
  }
  return found;
}
