/**
 * Find a kind of file a pack ships to present itself in a console (the factory view, the
 * factory overview), and the project files that present a pack it cannot edit.
 *
 * A project file `.archon/packs/<pack key><projectSuffix>` comes first; then
 * `<pack>/.shared/<fileName>` in every pack the project can run, with the scope precedence
 * metric views use. A project file replaces its pack's own file even when it is broken, as a
 * higher scope's declaration does for metric views: the project chose how to present the pack,
 * and its error is listed instead of the file it replaced. A file that cannot be read or does
 * not validate is listed under `errors` with its path; it never hides the others.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { readPackDeclarations } from './pack-declarations';
import { PACK_SHARED_DIRECTORY } from './packaged-workflow';
import type { FactoryViewSource } from './schemas/factory-view';
import { installedPackKey } from './workflow-source/installed-packs';
import type { LiveWorkflowSourceRoots } from './workflow-source/roots';

/** One kind of pack file: its name in a pack, its project-file suffix, and its schema. */
interface PackFileKind<T extends { pack: string }> {
  fileName: string;
  projectSuffix: string;
  schema: z.ZodType<T>;
}

interface PackFileFound<T> {
  pack: string;
  source: FactoryViewSource;
  path: string;
  declaration: T;
}

interface PackFileError {
  pack: string;
  source: FactoryViewSource;
  path: string;
  error: string;
}

type Listed<T> = PackFileFound<T> | PackFileError;

/** An installed pack's owner and name from its `owner/name`; a folder pack has none. */
export function installedIdentity(pack: string): { owner: string; name: string } | undefined {
  const slash = pack.indexOf('/');
  if (slash === -1) return undefined;
  return { owner: pack.slice(0, slash), name: pack.slice(slash + 1) };
}

/** The key a pack's project files are named by, as pack settings use: `owner.name` when installed. */
export function factoryPackKey(pack: string): string {
  const installed = installedIdentity(pack);
  return installed === undefined ? pack : installedPackKey(installed.owner, installed.name);
}

/** Every file of `kind` under `roots`, and every one that failed. */
export async function discoverPackFiles<T extends { pack: string }>(
  kind: PackFileKind<T>,
  roots: LiveWorkflowSourceRoots
): Promise<{ found: PackFileFound<T>[]; errors: PackFileError[] }> {
  const found: PackFileFound<T>[] = [];
  const errors: PackFileError[] = [];
  const project = roots.project === null ? [] : await projectFiles(kind, roots.project);
  // Pack keys with a project file; a broken file is listed under the key its name gives.
  const presented = new Set<string>();
  for (const listed of project) {
    if ('error' in listed) {
      errors.push(listed);
      presented.add(listed.pack);
    } else {
      found.push(listed);
      presented.add(factoryPackKey(listed.pack));
    }
  }
  const sharedPath = `${PACK_SHARED_DIRECTORY}/${kind.fileName}`;
  for (const read of await readPackDeclarations(roots, sharedPath)) {
    const listed =
      'error' in read
        ? read
        : parseDeclaration(kind, read.pack, read.source, read.path, read.content);
    if ('error' in listed) errors.push(listed);
    else if (!presented.has(factoryPackKey(listed.pack))) found.push(listed);
  }
  return { found, errors };
}

/** The project's `.archon/packs/*<projectSuffix>` files, by name. */
async function projectFiles<T extends { pack: string }>(
  kind: PackFileKind<T>,
  project: string
): Promise<Listed<T>[]> {
  const dir = join(project, '.archon', 'packs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [{ pack: dir, source: 'project-file', path: dir, error: (error as Error).message }];
  }
  const listed: Listed<T>[] = [];
  for (const name of names.filter(n => n.endsWith(kind.projectSuffix)).sort()) {
    const key = name.slice(0, -kind.projectSuffix.length);
    const path = join(dir, name);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      listed.push({ pack: key, source: 'project-file', path, error: (error as Error).message });
      continue;
    }
    listed.push(parseDeclaration(kind, key, 'project-file', path, content));
  }
  return listed;
}

/**
 * Parse one file found as `found`: a pack key for a project file, else the pack's identity.
 * The declaration's `pack` must agree with where it was found, or the console would present
 * one pack's runs under another's name.
 */
function parseDeclaration<T extends { pack: string }>(
  kind: PackFileKind<T>,
  found: string,
  source: FactoryViewSource,
  path: string,
  content: string
): Listed<T> {
  const failed = (error: string): Listed<T> => ({ pack: found, source, path, error });
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return failed(`${path} is not JSON: ${(error as Error).message}`);
  }
  const parsed = kind.schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
    return failed(`${path} is invalid: ${issues.join('; ')}`);
  }
  const pack = parsed.data.pack;
  const identity = source === 'project-file' ? factoryPackKey(pack) : pack;
  if (identity !== found)
    return failed(
      source === 'project-file'
        ? `${path} declares pack "${pack}", whose project file is ${factoryPackKey(pack)}${kind.projectSuffix}`
        : `${path} declares pack "${pack}" but belongs to pack "${found}"`
    );
  return { pack, source, path, declaration: parsed.data };
}
