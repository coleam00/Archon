/**
 * A pack's own document: one markdown file the pack's manifest names (`document`), else its
 * `how-it-works.md`, which explains the pack to an operator. Its frontmatter may declare
 * `groups`, how the pack's stages group into a few columns for display, `words`, the pack's
 * own words for what a reader counts across its runs, and `exit`, the stage items leave the
 * pack's flow by. The engine reads them and checks the groups and `exit` against the pack's
 * flow; it gives the document's text, a group's `kind` and the `words` no meaning and serves
 * them as written.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PLUGIN_MANIFEST_FILE, workflowPackManifestSchema } from '@archon/plugin-manifest';

/**
 * A group of stages for display: a name and its stages, by their authored `name:`, in order,
 * with an optional plain line (`blurb`) and an optional `kind`. `kind` is an opaque slug the
 * engine gives no meaning: a console maps it to its own colours. The object strips keys it
 * does not know rather than refusing them, so a document written for a newer Archon still
 * reads here; `documentGroups` reports each as a warning.
 */
export const packGroupSchema = z.object({
  name: z.string().trim().min(1),
  blurb: z.string().trim().min(1).max(160).optional(),
  stages: z.array(z.string().min(1)).min(1),
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'a kind is a lowercase slug')
    .optional(),
});
export type PackGroup = z.infer<typeof packGroupSchema>;

/**
 * The pack's words for what a reader counts across its runs, by a name the reader looks them up
 * by (for example a round, a work order). Opaque to the engine, as a group's `kind` is.
 */
export const packWordsSchema = z.record(
  z.string().regex(/^[a-z][A-Za-z0-9_-]*$/, 'a word name'),
  z.string().trim().min(1).max(80)
);
export type PackWords = z.infer<typeof packWordsSchema>;

const frontmatterSchema = z.object({
  groups: z.array(packGroupSchema).optional(),
  words: packWordsSchema.optional(),
  /** The stage items leave the pack's flow by, by its authored `name:`. */
  exit: z.string().min(1).optional(),
});
type Frontmatter = z.infer<typeof frontmatterSchema>;

/** The document a pack's manifest falls back to when it names none. */
export const DEFAULT_PACK_DOCUMENT = 'how-it-works.md';

/** Each key of the frontmatter, or of one of its groups, that the schemas above do not read. */
function unknownKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const top = Object.keys(raw).filter(key => !(key in frontmatterSchema.shape));
  const groups = (raw as { groups?: unknown }).groups;
  const nested = Array.isArray(groups)
    ? groups.flatMap((group: unknown, index) =>
        group !== null && typeof group === 'object' && !Array.isArray(group)
          ? Object.keys(group)
              .filter(key => !(key in packGroupSchema.shape))
              .map(key => `groups[${index}].${key}`)
          : []
      )
    : [];
  return [...top, ...nested];
}

/** The YAML between a leading `---` line and the next one; undefined when the text has none. */
function frontmatter(text: string): string | undefined {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end === -1 ? undefined : lines.slice(1, end).join('\n');
}

/** A document's text after its frontmatter: what an operator reads. */
export function documentBody(text: string): string {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0]?.trim() !== '---') return text;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return end === -1
    ? text
    : lines
        .slice(end + 1)
        .join('\n')
        .trimStart();
}

/**
 * What a document's frontmatter declares (nothing without frontmatter), with a warning for
 * each key it does not know, or why it does not read.
 */
export function documentGroups(
  text: string
):
  | { groups: PackGroup[]; words?: PackWords; exit?: string; warnings: string[] }
  | { problem: string } {
  const yaml = frontmatter(text);
  if (yaml === undefined) return { groups: [], warnings: [] };
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yaml);
  } catch (error) {
    return { problem: `its frontmatter is not valid YAML: ${(error as Error).message}` };
  }
  const parsed = frontmatterSchema.safeParse(raw ?? {});
  if (!parsed.success)
    return { problem: `its frontmatter is invalid: ${z.prettifyError(parsed.error)}` };
  const { words, exit }: Frontmatter = parsed.data;
  return {
    groups: parsed.data.groups ?? [],
    ...(words === undefined ? {} : { words }),
    ...(exit === undefined ? {} : { exit }),
    warnings: unknownKeys(raw).map(key => `unknown front-matter key '${key}' is ignored`),
  };
}

/**
 * `groups` checked against `stages`, the workflow names a group may hold: each group keeps
 * the stages that are among them and not already in an earlier group, and a group left with
 * none is dropped, so a stale name costs only itself. The problems name each stage dropped.
 */
export function checkGroups(
  groups: readonly PackGroup[],
  stages: readonly string[]
): { groups: PackGroup[]; problems: string[] } {
  const seen = new Set<string>();
  const problems: string[] = [];
  const kept = groups.flatMap(group => {
    const held = group.stages.filter(stage => {
      if (!stages.includes(stage)) {
        problems.push(
          `group '${group.name}' names '${stage}', which is not a stage of the pack's flow`
        );
        return false;
      }
      if (seen.has(stage)) {
        problems.push(`stage '${stage}' is in more than one group`);
        return false;
      }
      seen.add(stage);
      return true;
    });
    return held.length === 0 ? [] : [{ ...group, stages: held }];
  });
  return { groups: kept, problems };
}

/** Why `exit` cannot be the stage items leave the flow by: it is not one of the flow's stages. */
export function exitProblem(exit: string | undefined, inFlow: readonly string[]): string[] {
  return exit === undefined || inFlow.includes(exit)
    ? []
    : [`exit '${exit}' is not a stage of the pack's flow`];
}

/**
 * Each in-flow stage no group holds, once the document declares any group: a pack that
 * groups its stages groups all of them, so a stage added to the flow and left out of the
 * document is caught.
 */
export function ungroupedStages(groups: readonly PackGroup[], inFlow: readonly string[]): string[] {
  if (groups.length === 0) return [];
  const held = new Set(groups.flatMap(group => group.stages));
  return inFlow.filter(stage => !held.has(stage)).map(stage => `stage '${stage}' is in no group`);
}

interface PackDocumentRead {
  /** The document's path within the pack; null when the pack has none. */
  document: string | null;
  text: string;
  groups: PackGroup[];
  words?: PackWords;
  exit?: string;
  /** Why the document or its frontmatter does not read: errors, and then it has no groups. */
  problems: string[];
  /** Keys the frontmatter has that this Archon does not read. */
  warnings: string[];
  /** Whether the manifest names no document and `how-it-works.md` was read in its place. */
  fallback: boolean;
}

const NO_DOCUMENT: PackDocumentRead = {
  document: null,
  text: '',
  groups: [],
  problems: [],
  warnings: [],
  fallback: false,
};

/**
 * The document a pack directory's manifest names and the groups it declares. A manifest that
 * names none falls back to `how-it-works.md` at the pack root, for packs that lost the pointer
 * (Rasmus, 11/26); `document` says which file was read, and is null when the directory has no
 * pack manifest, or the manifest names none and the pack has no such file. A named document
 * that is missing or does not read is a problem, with no groups. The groups are as written:
 * `checkGroups` checks them against the pack's flow.
 */
export async function loadPackDocument(packDir: string): Promise<PackDocumentRead> {
  let manifest: z.infer<typeof workflowPackManifestSchema>;
  try {
    const raw: unknown = JSON.parse(await readFile(join(packDir, PLUGIN_MANIFEST_FILE), 'utf-8'));
    manifest = workflowPackManifestSchema.parse(raw);
  } catch {
    // No manifest, or one discovery already reports: the pack has no document.
    return NO_DOCUMENT;
  }
  const document = manifest.document ?? DEFAULT_PACK_DOCUMENT;
  const fallback = manifest.document === undefined;
  // Every message names the file, and says why a file the manifest never named was read.
  const where = fallback ? `${document} (read because the manifest names no document)` : document;
  let text: string;
  try {
    text = await readFile(join(packDir, document), 'utf-8');
  } catch (error) {
    // Only the fallback may be absent: a pack that never had the file has no document.
    if (fallback && (error as NodeJS.ErrnoException).code === 'ENOENT') return NO_DOCUMENT;
    return {
      ...NO_DOCUMENT,
      document,
      fallback,
      problems: [`${where} could not be read: ${(error as Error).message}`],
    };
  }
  const read = documentGroups(text);
  const body = documentBody(text);
  return 'problem' in read
    ? { ...NO_DOCUMENT, document, fallback, text: body, problems: [`${where}: ${read.problem}`] }
    : {
        document,
        fallback,
        text: body,
        groups: read.groups,
        ...(read.words === undefined ? {} : { words: read.words }),
        ...(read.exit === undefined ? {} : { exit: read.exit }),
        problems: [],
        warnings: read.warnings.map(warning => `${where}: ${warning}`),
      };
}
