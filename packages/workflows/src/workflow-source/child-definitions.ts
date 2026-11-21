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
import { cp, mkdir, mkdtemp, rm, stat } from 'fs/promises';
import { dirname, join, sep } from 'path';
import { execFileAsync } from '@archon/git';
import * as archonPaths from '@archon/paths';
import type { BaseRunDefinitions } from '../schemas/run-metadata';
import { isSystemError } from './integrity';
import { isDirectory, listTree, projectSourceDirs } from './tree';

type ChangedFiles = NonNullable<BaseRunDefinitions['run_files']>['files'];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

const nulList = (stdout: string): string[] => stdout.split('\0').filter(entry => entry !== '');

/** Checkout-relative definition paths for every command folder named. */
function definitionPaths(commandFolders: readonly (string | undefined)[]): string[] {
  const dirs = new Set(commandFolders.flatMap(folder => projectSourceDirs(folder)));
  return [...dirs, join('.archon', 'config.yaml')].map(path => path.split(sep).join('/'));
}

/**
 * The definition files `checkout` changed since `since`: committed or not, untracked or
 * ignored. Paths are relative to `checkout`.
 */
async function changedSince(
  checkout: string,
  since: string,
  paths: readonly string[]
): Promise<ChangedFiles> {
  const files: ChangedFiles = [];
  // `--relative` keeps every path relative to the checkout, as the capture lays it out.
  const tracked = nulList(
    await git(checkout, [
      'diff',
      '--relative',
      '--name-status',
      '--no-renames',
      '-z',
      since,
      '--',
      ...paths,
    ])
  );
  for (let index = 0; index + 1 < tracked.length; index += 2) {
    const status = tracked[index];
    files.push({
      path: tracked[index + 1],
      change: status === 'D' ? 'deleted' : status === 'A' ? 'added' : 'modified',
    });
  }
  const others = ['ls-files', '-z', '--others', '--exclude-standard'];
  for (const path of nulList(await git(checkout, [...others, '--', ...paths])))
    files.push({ path, change: 'added' });
  for (const path of nulList(await git(checkout, [...others, '--ignored', '--', ...paths])))
    files.push({ path, change: 'ignored' });
  return files;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isSystemError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * The child's layer: what `checkout` changed since `since`, then what the parent's own
 * layer took from the same checkout, laid again as the checkout has it now (a file the
 * parent's checkout restored since replaces the copy the parent captured), then a command
 * folder the checkout's config now selects and the parent never captured, whole.
 */
async function childLayer(
  input: ChildDefinitionsInput,
  checkoutFolder: string | undefined
): Promise<ChangedFiles> {
  const layer = new Map<string, ChangedFiles[number]>();
  const paths = definitionPaths([input.commandFolder, checkoutFolder]);
  for (const file of await changedSince(input.checkout, input.since, paths))
    layer.set(file.path, file);
  for (const file of await reappliedFiles(input))
    if (!layer.has(file.path)) layer.set(file.path, file);
  for (const file of await newCommandFolder(input, checkoutFolder))
    if (!layer.has(file.path)) layer.set(file.path, file);
  return [...layer.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The files the parent's own layer took from this checkout, as the checkout has them now. */
async function reappliedFiles(input: ChildDefinitionsInput): Promise<ChangedFiles> {
  const inherited = input.definitions.run_files;
  if (inherited?.checkout !== input.checkout) return [];
  const files: ChangedFiles = [];
  for (const file of inherited.files) {
    const now = await exists(join(input.checkout, file.path));
    files.push({ path: file.path, change: now ? 'modified' : 'deleted' });
  }
  return files;
}

/** A command folder the checkout's config selects and the parent never captured, whole. */
async function newCommandFolder(
  input: ChildDefinitionsInput,
  checkoutFolder: string | undefined
): Promise<ChangedFiles> {
  if (!checkoutFolder) return [];
  const captured = new Set(definitionPaths([input.commandFolder]));
  if (captured.has(checkoutFolder.split(sep).join('/'))) return [];
  const folder = join(input.checkout, checkoutFolder);
  if (!(await isDirectory(folder))) return [];
  return (await listTree(folder)).files.map(file => ({
    path: join(checkoutFolder, file.relPath).split(sep).join('/'),
    change: 'added' as const,
  }));
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
  const changed = await childLayer(input, checkoutFolder);
  const temp = archonPaths.getArchonTempPath();
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, 'child-definitions-'));
  try {
    if (await isDirectory(input.parentProject))
      await cp(input.parentProject, root, { recursive: true, dereference: true });
    for (const file of changed) {
      const target = join(root, file.path);
      if (file.change === 'deleted') {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(join(input.checkout, file.path), target, { dereference: true, force: true });
    }
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
