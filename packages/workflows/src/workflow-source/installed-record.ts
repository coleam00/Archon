import type { InstalledPack } from './installed-packs';
import { z } from 'zod';

/** Where an installed pack came from, as its receipt recorded it. */
export const installedPluginRecordSchema = z.object({
  /** The installed pack key: the pack's directory in a capture. */
  key: z.string(),
  /** `owner/repo[/path]` */
  id: z.string(),
  commit: z.string(),
  tag: z.string().optional(),
});

export type InstalledPluginRecord = z.infer<typeof installedPluginRecordSchema>;

/** The public name of a workflow in an installed pack: `owner/plugin:<name>`. */
export function installedWorkflowName(
  pack: Pick<InstalledPack, 'owner' | 'name'>,
  name: string
): string {
  return `${pack.owner}/${pack.name}:${name}`;
}

export function installedPackKey(owner: string, name: string): string {
  return `${owner}.${name}`;
}
