/**
 * What `archon pack bindings` does about files already at the paths it is about to write:
 * without `--force` it refuses the whole set, with it it says when a replaced file changes
 * the run config its starts use.
 */
import { readFile } from 'node:fs/promises';

interface GeneratedFile {
  path: string;
  document: unknown;
}

function configSourceOf(document: unknown): string | undefined {
  const binding = (document as { binding?: { launch?: { configSource?: unknown } } }).binding;
  const value = binding?.launch?.configSource;
  return typeof value === 'string' ? value : undefined;
}

/** The file's text, or undefined when nothing readable is there. */
async function existing(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A replaced file can change which run config its starts use, and the file it replaces is
 * the only record of the old one: regenerating without `--config` silently puts a lane back
 * on the install's config. Say what changed while the old value is still readable.
 */
function warnOnRunConfigChange(item: GeneratedFile, replacedText: string): void {
  let previous: string | undefined;
  try {
    previous = configSourceOf(JSON.parse(replacedText) as unknown);
  } catch {
    // Not a binding file we can read: nothing to compare against.
    return;
  }
  const next = configSourceOf(item.document);
  if (previous === next) return;
  if (previous !== undefined && next !== undefined) {
    console.warn(
      `warning: ${item.path} replaced a binding whose starts ran on ${previous} with one that runs on ${next}.`
    );
  } else if (previous !== undefined) {
    console.warn(
      `warning: ${item.path} removed its run config (${previous}); its starts run on the install's config. Pass --config to keep it.`
    );
  } else {
    console.warn(`warning: ${item.path} added run config ${next} to a binding that had none.`);
  }
}

export async function checkReplacedFiles(
  generated: readonly GeneratedFile[],
  force: boolean
): Promise<void> {
  const present: { item: GeneratedFile; text: string }[] = [];
  for (const item of generated) {
    const text = await existing(item.path);
    if (text !== undefined) present.push({ item, text });
  }
  if (present.length === 0) return;
  if (!force) {
    throw new Error(
      `Refusing to overwrite ${present.map(({ item }) => item.path).join(', ')}. Nothing was written. Pass --force to replace ${present.length === 1 ? 'it' : 'them'}.`
    );
  }
  for (const { item, text } of present) warnOnRunConfigChange(item, text);
}
