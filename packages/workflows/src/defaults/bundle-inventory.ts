import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { z } from 'zod';
import {
  formatPackagedResourceReference,
  isValidWorkflowFolderSegment,
  PACK_SHARED_DIRECTORY,
  type WorkflowResourceOwner,
} from '../packaged-workflow';
import type { BundledScriptPack } from './bundled-script-pack';

const indexSchema = z
  .object({
    $comment: z.string().optional(),
    packs: z
      .array(z.string().refine(isValidWorkflowFolderSegment, 'Invalid bundle pack name'))
      .refine(packs => new Set(packs).size === packs.length, 'Duplicate bundle pack'),
  })
  .strict();

/** The generator's fixture repos provide their own index; production uses this module's. */
export async function readBundleIndex(
  path = join(import.meta.dir, 'bundle-index.json')
): Promise<string[]> {
  return indexSchema.parse(JSON.parse(await readFile(path, 'utf8'))).packs;
}

/**
 * Whether a bundled `pack/workflow` reference can resolve from live source. A pack the
 * index no longer names has stopped shipping, and `defaults` ships flat workflows and
 * commands rather than packaged resources, so it never owns one.
 */
export async function bundlesPackagedResources(pack: string): Promise<boolean> {
  return pack !== 'defaults' && (await readBundleIndex()).includes(pack);
}

/**
 * Where a live bundled default command lives, or null when the index no longer ships
 * `defaults`. The scope is exactly the flat files `defaultCommandFiles` selects, so a
 * command resolves by direct path. Routing it through a recursive, basename-deduped walk
 * instead lets a same-named file one folder deeper take the name's slot, which drops the
 * root command from the walk and turns it into a bare "not found".
 *
 * The path is not proof the file exists. The caller reads or stats it and owns that error.
 */
export async function bundledDefaultCommandPath(
  commandsDefaultsRoot: string,
  commandName: string
): Promise<string | null> {
  return (await readBundleIndex()).includes('defaults')
    ? join(commandsDefaultsRoot, `${commandName}.md`)
    : null;
}

/** The live bundled default command names — the same flat selection, listed. Empty when
 * the index no longer ships `defaults` or the directory is absent. */
export async function listBundledDefaultCommands(commandsDefaultsRoot: string): Promise<string[]> {
  if (!(await readBundleIndex()).includes('defaults')) return [];
  try {
    return (await defaultCommandFiles(commandsDefaultsRoot)).map(file => file.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

type Owner = Pick<WorkflowResourceOwner, 'pack' | 'workflow'>;
type Script = BundledScriptPack['scripts'][string];

/** Selection is shared by generation and live capture. Reading bytes is a separate step so
 * a warm capture can revalidate the selected files without reading them all again. */
export type BundleSourceFile = {
  readonly sourcePath: string;
  /** Path beneath the capture's bundled scope, always using forward slashes. */
  readonly relativePath: string;
} & (
  | { readonly kind: 'workflow'; readonly name: string; readonly owner?: Owner }
  | { readonly kind: 'command'; readonly name: string }
  | {
      readonly kind: 'script';
      readonly pack: string;
      readonly packPath: string;
      readonly entry?: { readonly name: string; readonly runtime: Script['runtime'] };
    }
);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** SDK consumers may have no installed source tree. Once either root exists, the
 * complete indexed selection must be valid; a partial installation is an error. */
export async function collectInstalledBundleSources(
  workflowsRoot: string,
  commandsRoot: string
): Promise<BundleSourceFile[] | undefined> {
  const [hasWorkflows, hasCommands] = await Promise.all([
    installedRootExists(workflowsRoot),
    installedRootExists(commandsRoot),
  ]);
  if (!hasWorkflows && !hasCommands) return undefined;
  return collectBundleSources(workflowsRoot, commandsRoot, await readBundleIndex());
}

async function installedRootExists(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) {
      throw new Error(`Bundled source root is not a directory: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validateName(name: string, path: string): void {
  if (!isValidWorkflowFolderSegment(name))
    throw new Error(`Invalid bundled filename or directory "${path}".`);
}

function validateDefaultName(name: string, path: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `Bundled default has invalid filename "${path}". Names must be kebab-case (lowercase letters, digits, hyphens).`
    );
  }
}

function runtime(extension: string): Script['runtime'] | undefined {
  if (extension === '.py') return 'uv';
  if (extension === '.ts' || extension === '.js') return 'bun';
  return undefined;
}

// Non-shared bundled sources have always dereferenced authored links. Dirent alone
// describes the link, so using its isFile/isDirectory would silently omit those files.
async function entryType(
  directory: string,
  entry: Dirent
): Promise<Pick<Dirent, 'isFile' | 'isDirectory'>> {
  return entry.isSymbolicLink() ? await stat(join(directory, entry.name)) : entry;
}

/** The bundled `defaults` command scope: the flat `.md` files directly under the commands
 * defaults root. Selection and live resolution read the scope through this one walk, so a
 * file a capture would never carry can never resolve as a command either. */
async function defaultCommandFiles(
  directory: string
): Promise<{ name: string; fileName: string }[]> {
  const files: { name: string; fileName: string }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.md') || !(await entryType(directory, entry)).isFile()) continue;
    files.push({ name: basename(entry.name, '.md'), fileName: entry.name });
  }
  return files;
}

async function sharedModules(directory: string): Promise<string[]> {
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error(`Shared module symlinks are not supported: ${directory}`);
  }
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Shared module symlinks are not supported: ${path}`);
    if (entry.isDirectory()) files.push(...(await sharedModules(path)));
    else if (entry.isFile() && runtime(extname(entry.name))) files.push(path);
  }
  return files;
}

/** Only the indexed packs are inspected. Fixtures, prose and unrelated directories never
 * enter the bundle merely because they live beside a workflow. A named missing pack fails. */
export async function collectBundleSources(
  workflowsRoot: string,
  commandsRoot: string,
  packs: readonly string[]
): Promise<BundleSourceFile[]> {
  const files: BundleSourceFile[] = [];
  const workflowNames = new Set<string>();
  const commandNames = new Set<string>();
  const add = (file: BundleSourceFile): void => {
    if (file.kind !== 'script') {
      const names = file.kind === 'workflow' ? workflowNames : commandNames;
      if (names.has(file.name))
        throw new Error(`Bundled ${file.kind} filename collision: "${file.name}".`);
      names.add(file.name);
    }
    files.push(file);
  };
  const workflowFile = (path: string, owner?: Owner): void => {
    const name = basename(path, extname(path));
    if (owner === undefined) validateDefaultName(name, path);
    else validateName(name, path);
    add({
      kind: 'workflow',
      name,
      owner,
      sourcePath: path,
      relativePath: `workflows/${relative(workflowsRoot, path).replaceAll('\\', '/')}`,
    });
  };
  const flatWorkflows = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        (await entryType(directory, entry)).isFile() &&
        ['.yaml', '.yml'].includes(extname(entry.name))
      )
        workflowFile(join(directory, entry.name));
    }
  };
  for (const pack of [...packs].sort()) {
    validateName(pack, pack);
    const packRoot = join(workflowsRoot, pack);
    if (!(await isDirectory(packRoot)))
      throw new Error(`Indexed bundle pack "${pack}" directory not found: ${packRoot}`);
    if (pack === 'defaults') {
      await flatWorkflows(packRoot);
      if (await isDirectory(join(packRoot, 'legacy')))
        await flatWorkflows(join(packRoot, 'legacy'));
      const defaults = join(commandsRoot, 'defaults');
      if (!(await isDirectory(defaults)))
        throw new Error(`Commands defaults directory not found: ${defaults}`);
      for (const { name, fileName } of await defaultCommandFiles(defaults)) {
        validateDefaultName(name, fileName);
        add({
          kind: 'command',
          name,
          sourcePath: join(defaults, fileName),
          relativePath: `commands/defaults/${fileName}`,
        });
      }
      continue;
    }
    const shared = join(packRoot, PACK_SHARED_DIRECTORY);
    if (await isDirectory(shared)) {
      for (const path of await sharedModules(shared)) {
        const packPath = relative(packRoot, path).replaceAll('\\', '/');
        add({
          kind: 'script',
          pack,
          packPath,
          sourcePath: path,
          relativePath: `workflows/${pack}/${packPath}`,
        });
      }
    }
    for (const entry of await readdir(packRoot, { withFileTypes: true })) {
      if (entry.name === PACK_SHARED_DIRECTORY || !(await entryType(packRoot, entry)).isDirectory())
        continue;
      const workflow = entry.name;
      validateName(workflow, `${pack}/${workflow}`);
      const directory = join(packRoot, workflow);
      const yamlFiles = (await readdir(directory)).filter(name =>
        ['.yaml', '.yml'].includes(extname(name))
      );
      if (yamlFiles.length !== 1)
        throw new Error(
          `Packaged workflow "${pack}/${workflow}" must contain exactly one .yaml or .yml file (found ${yamlFiles.length}).`
        );
      workflowFile(join(directory, yamlFiles[0]), { pack, workflow });
      const owner = { source: 'bundled' as const, pack, workflow };
      const commands = join(directory, 'commands');
      if (await isDirectory(commands)) {
        for (const entry of await readdir(commands, { withFileTypes: true })) {
          if (!(await entryType(commands, entry)).isFile() || !entry.name.endsWith('.md')) continue;
          const name = basename(entry.name, '.md');
          validateName(name, entry.name);
          add({
            kind: 'command',
            name: formatPackagedResourceReference(owner, name),
            sourcePath: join(commands, entry.name),
            relativePath: `workflows/${pack}/${workflow}/commands/${entry.name}`,
          });
        }
      }
      const scripts = join(directory, 'scripts');
      if (await isDirectory(scripts)) {
        const seen = new Set<string>();
        for (const entry of await readdir(scripts, { withFileTypes: true })) {
          const kind = await entryType(scripts, entry);
          const candidates: string[] = [];
          if (kind.isDirectory()) {
            const directory = join(scripts, entry.name);
            for (const child of await readdir(directory, { withFileTypes: true })) {
              if ((await entryType(directory, child)).isFile())
                candidates.push(`${entry.name}/${child.name}`);
            }
          } else if (kind.isFile()) candidates.push(entry.name);
          for (const candidate of candidates) {
            const extension = extname(candidate);
            const scriptRuntime = runtime(extension);
            if (scriptRuntime === undefined) continue;
            const name = basename(candidate, extension);
            validateName(name, candidate);
            if (seen.has(name))
              throw new Error(`Duplicate packaged script "${name}" in ${pack}/${workflow}.`);
            seen.add(name);
            const packPath = `${workflow}/scripts/${candidate}`;
            add({
              kind: 'script',
              pack,
              packPath,
              sourcePath: join(packRoot, packPath),
              relativePath: `workflows/${pack}/${packPath}`,
              entry: { name: formatPackagedResourceReference(owner, name), runtime: scriptRuntime },
            });
          }
        }
      }
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function readBundleContent(file: BundleSourceFile): Promise<string> {
  const content = (await readFile(file.sourcePath, 'utf8')).replace(/\r\n/g, '\n');
  // Empty shared modules (e.g. Python __init__.py) are meaningful, unlike entry points.
  if (!content.trim() && !(file.kind === 'script' && file.entry === undefined)) {
    throw new Error(`Bundled default "${file.sourcePath}" is empty.`);
  }
  return content;
}
