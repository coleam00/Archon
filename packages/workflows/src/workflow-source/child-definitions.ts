/**
 * The definitions a `workflow:` child of a parent with base-branch definitions starts
 * with: the parent's captured project scope, with the definition files the parent's
 * execution checkout changed since the parent started laid on top.
 *
 * The parent's capture carries the base commit and the operator's uncommitted files as
 * they were at the parent's start. The execution checkout is where the run itself works,
 * so a child workflow the run writes there, or one an operator fixes there before resuming
 * the parent, is what the child runs. Composed when the child starts, as a live origin is
 * read then. Nothing is written into either checkout.
 */
import { cp, mkdir, mkdtemp, rm } from 'fs/promises';
import { join, sep } from 'path';
import * as archonPaths from '@archon/paths';
import type { BaseRunDefinitions } from '../schemas/run-metadata';
import {
  changedPaths,
  commitView,
  worktreeView,
  writeEntry,
  type DefinitionView,
} from './definition-views';
import { isDirectory, projectSourceDirs } from './tree';

type ChangedFiles = NonNullable<BaseRunDefinitions['run_files']>['files'];

/** Checkout-relative definition paths for every command folder named. */
function definitionPaths(commandFolders: readonly (string | undefined)[]): string[] {
  const dirs = new Set(commandFolders.flatMap(folder => projectSourceDirs(folder)));
  return [...dirs, join('.archon', 'config.yaml')].map(path => path.split(sep).join('/'));
}

/**
 * The child's layer, read from one view of the checkout as it is now: what the checkout
 * changed since `since`, then what the parent's own layer took from the same checkout,
 * laid again as the checkout has it now (a file the parent's checkout restored since
 * replaces the copy the parent captured), then a command folder the checkout's config now
 * selects and the parent never captured, whole. Links and submodules resolve as they do
 * for the parent's own definitions.
 */
async function childLayer(
  input: ChildDefinitionsInput,
  checkoutFolder: string | undefined,
  now: DefinitionView
): Promise<ChangedFiles> {
  const layer = new Map<string, ChangedFiles[number]>();
  const paths = definitionPaths([input.commandFolder, checkoutFolder]);
  for (const file of changedPaths(await commitView(input.checkout, input.since, paths), now))
    layer.set(file.path, file);
  for (const file of [
    ...reappliedFiles(input, now),
    ...newCommandFolder(input, checkoutFolder, now),
  ])
    if (!layer.has(file.path)) layer.set(file.path, file);
  return [...layer.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What the parent's own layer took from this checkout, as the checkout has it now. */
function reappliedFiles(input: ChildDefinitionsInput, now: DefinitionView): ChangedFiles {
  const inherited = input.definitions.run_files;
  if (inherited?.checkout !== input.checkout) return [];
  return inherited.files.map(file => ({
    path: file.path,
    change: now.has(file.path) ? 'modified' : 'deleted',
  }));
}

/** A command folder the checkout's config selects and the parent never captured, whole. */
function newCommandFolder(
  input: ChildDefinitionsInput,
  checkoutFolder: string | undefined,
  now: DefinitionView
): ChangedFiles {
  const folder = checkoutFolder?.split(sep).join('/');
  if (!folder || new Set(definitionPaths([input.commandFolder])).has(folder)) return [];
  return [...now.keys()]
    .filter(path => path.startsWith(`${folder}/`))
    .map(path => ({ path, change: 'added' as const }));
}

interface ChildDefinitionsInput {
  parentProject: string;
  definitions: BaseRunDefinitions;
  checkout: string;
  since: string;
  commandFolder: string | undefined;
  /** Reads the checkout's config, whose `commands.folder` may differ from the parent's. */
  loadConfig: (cwd: string) => Promise<{ commands?: { folder?: string } }>;
}

/**
 * Compose a child's definitions in a temporary project root, hand it to `use`, then
 * remove it. `since` is the commit the parent's checkout started at. A parent with no
 * project scope (it runs global, installed or bundled workflows) gives an empty one.
 */
export async function withChildDefinitions<T>(
  input: ChildDefinitionsInput,
  use: (composed: { root: string; definitions: BaseRunDefinitions }) => Promise<T>
): Promise<T> {
  const checkoutFolder = (await input.loadConfig(input.checkout)).commands?.folder;
  const now = await worktreeView(
    input.checkout,
    definitionPaths([input.commandFolder, checkoutFolder])
  );
  const changed = await childLayer(input, checkoutFolder, now);
  const temp = archonPaths.getArchonTempPath();
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, 'child-definitions-'));
  try {
    if (await isDirectory(input.parentProject))
      await cp(input.parentProject, root, { recursive: true, dereference: true });
    for (const file of changed) await writeEntry(root, file.path, now.get(file.path));
    return await use({
      root,
      definitions: {
        ...input.definitions,
        run_files: { checkout: input.checkout, since: input.since, files: changed },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
