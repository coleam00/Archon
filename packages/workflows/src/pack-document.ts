/**
 * A pack's own document: one markdown file the pack's manifest names (`document`), which
 * explains the pack to an operator. Its frontmatter may declare `groups`, how the pack's
 * stages group into a few columns for display. The engine reads the groups and checks them
 * against the pack's stages; it gives the document's text no meaning.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PLUGIN_MANIFEST_FILE, workflowPackManifestSchema } from '@archon/plugin-manifest';

/** A group of stages for display: a name and its stages, by their authored `name:`, in order. */
export const packGroupSchema = z.strictObject({
  name: z.string().trim().min(1),
  stages: z.array(z.string().min(1)).min(1),
});
export type PackGroup = z.infer<typeof packGroupSchema>;

const frontmatterSchema = z.object({ groups: z.array(packGroupSchema).optional() });

/** The YAML between a leading `---` line and the next one; undefined when the text has none. */
function frontmatter(text: string): string | undefined {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end === -1 ? undefined : lines.slice(1, end).join('\n');
}

/** The groups a document's frontmatter declares (none without frontmatter), or why it does not read. */
export function documentGroups(text: string): { groups: PackGroup[] } | { problem: string } {
  const yaml = frontmatter(text);
  if (yaml === undefined) return { groups: [] };
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yaml);
  } catch (error) {
    return { problem: `its frontmatter is not valid YAML: ${(error as Error).message}` };
  }
  const parsed = frontmatterSchema.safeParse(raw ?? {});
  if (!parsed.success)
    return { problem: `its frontmatter 'groups' is invalid: ${z.prettifyError(parsed.error)}` };
  return { groups: parsed.data.groups ?? [] };
}

/**
 * What is wrong with `groups` for a pack whose stages are `stages`: a stage a group names
 * that is not one of them, or one named twice. A stage in no group is fine: it keeps a
 * column of its own.
 */
export function groupProblems(groups: readonly PackGroup[], stages: readonly string[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const group of groups)
    for (const stage of group.stages) {
      if (!stages.includes(stage))
        problems.push(
          `group '${group.name}' names '${stage}', which is not a stage of the pack's flow`
        );
      else if (seen.has(stage)) problems.push(`stage '${stage}' is in more than one group`);
      seen.add(stage);
    }
  return problems;
}

/**
 * The document a pack directory's manifest names and the groups it declares. `document` is
 * null when the directory has no pack manifest or the manifest names none. A document that
 * is missing or does not read is a problem, with no groups.
 */
export async function loadPackDocument(
  packDir: string
): Promise<{ document: string | null; groups: PackGroup[]; problems: string[] }> {
  let manifest: z.infer<typeof workflowPackManifestSchema>;
  try {
    const raw: unknown = JSON.parse(await readFile(join(packDir, PLUGIN_MANIFEST_FILE), 'utf-8'));
    manifest = workflowPackManifestSchema.parse(raw);
  } catch {
    // No manifest, or one discovery already reports: the pack has no document.
    return { document: null, groups: [], problems: [] };
  }
  const document = manifest.document ?? null;
  if (document === null) return { document, groups: [], problems: [] };
  let text: string;
  try {
    text = await readFile(join(packDir, document), 'utf-8');
  } catch (error) {
    return {
      document,
      groups: [],
      problems: [`${document} could not be read: ${(error as Error).message}`],
    };
  }
  const read = documentGroups(text);
  return 'problem' in read
    ? { document, groups: [], problems: [`${document}: ${read.problem}`] }
    : { document, groups: read.groups, problems: [] };
}
