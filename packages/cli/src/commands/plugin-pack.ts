/**
 * Install a `workflow-pack` plugin: the tag, or the default branch head, is fetched
 * with git at depth 1 and the plugin directory of that commit becomes one installed
 * tree that workflow discovery reads.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileAsync } from '@archon/git';
import {
  describeIssues,
  PLUGIN_MANIFEST_FILE,
  pluginReceiptSchema,
  type PluginReceipt,
  type WorkflowPackReceipt,
  type WorkflowPackManifest,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import { packTreePath, receiptPath, RECEIPT_FILE } from '@archon/plugin-manifest/store';
import type { PluginRef, resolveSource } from './plugin-source';
import { assertCompatible, stagingName, type PluginEnvironment } from './plugin-common';

/** Git with no prompts: a missing or private repository fails instead of waiting for input. */
async function git(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return stdout;
}

/** A workflow pack at one commit, fetched and checked but not yet written anywhere readers look. */
interface FetchedPack {
  gitDir: string;
  commit: string;
  /** The plugin directory inside the commit, `''` or ending in `/`: listed, checked and written. */
  prefix: string;
  /** The tree's own `archon-plugin.json`: discovery reads this file, so it is the one checked. */
  manifest: WorkflowPackManifest;
  /** Every file of the plugin, relative to its root. */
  files: ReadonlySet<string>;
}

/** Fetch `tag`, or the default branch head, at depth 1 into a new bare repository; returns its commit. */
async function fetchCommit(
  gitDir: string,
  remote: string,
  tag: string | undefined
): Promise<string> {
  await git(['init', '--bare', '-q', gitDir]);
  // `info/attributes` outranks every other attributes source, including a
  // `.gitattributes` inside the pack: no end-of-line conversion, `$Id$` expansion,
  // filter driver or re-encoding touches the checkout, so the installed bytes are the
  // committed bytes on every machine.
  await mkdir(join(gitDir, 'info'), { recursive: true });
  await writeFile(
    join(gitDir, 'info', 'attributes'),
    '* -text -ident -filter -working-tree-encoding\n'
  );
  try {
    await git([
      '--git-dir',
      gitDir,
      'fetch',
      '--depth',
      '1',
      '--no-tags',
      remote,
      tag ? `refs/tags/${tag}` : 'HEAD',
    ]);
  } catch (error) {
    throw new Error(`Could not fetch ${tag ?? 'HEAD'} of ${remote}: ${(error as Error).message}`);
  }
  return (await git(['--git-dir', gitDir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
}

/** One `ls-tree -z` record as a path relative to the plugin directory, refused unless a pack can hold it. */
function packFile(ref: PluginRef, record: string, prefix: string): string {
  const tab = record.indexOf('\t');
  const [mode] = record.slice(0, tab).split(' ');
  const relative = record.slice(tab + 1).slice(prefix.length);
  if (relative.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Refusing ${ref.id}: "${relative}" escapes the plugin directory`);
  }
  if (/[\\:]/.test(relative)) {
    throw new Error(
      `Refusing ${ref.id}: "${relative}" contains \\ or :, which Windows reads as path syntax`
    );
  }
  // Regular files only, by git mode: 120000 is a symlink, 160000 a submodule.
  if (mode !== '100644' && mode !== '100755') {
    const kind =
      mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : `git mode ${mode}`;
    throw new Error(
      `Refusing ${ref.id}: "${relative}" is a ${kind}; a workflow pack may contain only regular files`
    );
  }
  return relative;
}

async function listPackFiles(
  ref: PluginRef,
  gitDir: string,
  commit: string,
  prefix: string
): Promise<Set<string>> {
  const listing = await git([
    '--git-dir',
    gitDir,
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
    ...(prefix ? ['--', prefix] : []),
  ]);
  return new Set(
    listing
      .split('\0')
      .filter(record => record)
      .map(record => packFile(ref, record, prefix))
  );
}

/**
 * The raw manifest read that chose this path was at the resolved commit; the fetched
 * commit's own manifest is the one installed, and it must still describe a pack.
 */
async function readPackManifest(
  ref: PluginRef,
  gitDir: string,
  commit: string,
  prefix: string
): Promise<WorkflowPackManifest> {
  const manifestPath = `${commit}:${prefix}${PLUGIN_MANIFEST_FILE}`;
  let raw: unknown;
  try {
    raw = JSON.parse(await git(['--git-dir', gitDir, 'cat-file', 'blob', manifestPath]));
  } catch (error) {
    throw new Error(`Refusing ${ref.id}: cannot read ${manifestPath}: ${(error as Error).message}`);
  }
  const parsed = workflowPackManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Refusing ${ref.id}: ${manifestPath} is not a workflow pack manifest: ${describeIssues(parsed.error)}`
    );
  }
  return parsed.data;
}

/**
 * Fetch the tag, or the default branch head, at depth 1 into a private repository and
 * read the plugin directory out of that one commit. Fetching by ref name needs no
 * server support for fetching an arbitrary commit; the commit it returns is the one
 * installed, so nothing afterwards can mix revisions.
 *
 * Refuses, by path, every entry the pack could not hold faithfully: a symlink or
 * submodule, a `..` or empty segment, and a name containing `\` or `:`, which Windows
 * reads as path syntax (git itself writes such names verbatim on other platforms).
 * Only the plugin directory is listed, so the rest of the repository never matters.
 */
async function fetchPack(
  ref: PluginRef,
  tag: string | undefined,
  staging: string,
  env: PluginEnvironment
): Promise<FetchedPack> {
  const remote = `${env.githubUrl ?? 'https://github.com'}/${ref.owner}/${ref.repo}.git`;
  const gitDir = join(staging, 'repo.git');
  const commit = await fetchCommit(gitDir, remote, tag);
  const prefix = ref.path.length > 0 ? `${ref.path.join('/')}/` : '';
  const files = await listPackFiles(ref, gitDir, commit, prefix);
  const manifest = await readPackManifest(ref, gitDir, commit, prefix);
  return { gitDir, commit, prefix, manifest, files };
}

/** Proves the tree is the pack its manifest describes before anything is written. */
function assertPackTree(
  ref: PluginRef,
  manifest: WorkflowPackManifest,
  files: ReadonlySet<string>
): void {
  for (const [name, path] of Object.entries(manifest.entrypoints)) {
    const folder = `${path.split('/')[0]}/`;
    const yamls = [...files].filter(
      file =>
        file.startsWith(folder) && !file.slice(folder.length).includes('/') && /\.ya?ml$/.test(file)
    );
    if (!files.has(path)) {
      throw new Error(
        `Refusing ${ref.id}: entrypoint "${name}" names ${path}, which is not in the pack`
      );
    }
    // The packaged layout loads exactly one YAML per workflow folder.
    if (yamls.length !== 1) {
      throw new Error(
        `Refusing ${ref.id}: entrypoint "${name}" is in ${folder}, which must hold exactly one .yaml file (found ${yamls.length})`
      );
    }
  }
}

export async function installPack(
  ref: PluginRef,
  source: Extract<Awaited<ReturnType<typeof resolveSource>>, { kind: 'workflow-pack' }>,
  receipts: PluginReceipt[],
  previous: WorkflowPackReceipt | undefined,
  env: PluginEnvironment
): Promise<void> {
  const { tag } = source;
  const receiptFile = receiptPath(env.pluginsDir, ref.id);
  const writeReceipt = async (receipt: PluginReceipt): Promise<void> => {
    await mkdir(dirname(receiptFile), { recursive: true });
    const staged = join(dirname(receiptFile), stagingName(RECEIPT_FILE));
    try {
      await writeFile(staged, `${JSON.stringify(pluginReceiptSchema.parse(receipt), null, 2)}\n`);
      await rename(staged, receiptFile);
    } finally {
      await rm(staged, { force: true });
    }
  };

  // The installed commit again: its tree already holds these bytes. Settled without a
  // fetch, and without replacing the tree, which would briefly leave the receipt
  // pointing at no tree. Only a different tag label changes, in the receipt.
  // The range is still checked, so an update that installs nothing tells the operator
  // the pack is outside this Archon's range, as a forge update does.
  const settleSameCommit = async (
    commit: string,
    manifest: WorkflowPackManifest
  ): Promise<boolean> => {
    if (previous?.commit !== commit) return false;
    assertCompatible(`${ref.id}@${tag ?? commit}`, manifest, env.archonVersion);
    if (previous.tag === tag) {
      console.log(`${ref.id} is already at ${tag ?? 'the default branch head'} (commit ${commit})`);
      return true;
    }
    await writeReceipt({
      schemaVersion: 1,
      id: previous.id,
      manifest: previous.manifest,
      ...(tag ? { tag } : {}),
      commit,
      installedAt: new Date().toISOString(),
    });
    console.log(
      `Updated ${ref.id}: ${previous.tag ?? 'default branch'} -> ${tag ?? 'default branch'} (commit ${commit}); files unchanged`
    );
    return true;
  };
  if (await settleSameCommit(source.commit, source.manifest)) return;

  // Everything fetched and checked lives here until the tree is renamed into place.
  const staging = join(env.pluginsDir, stagingName('pack'));
  await mkdir(staging, { recursive: true });
  try {
    const { gitDir, commit, prefix, manifest, files } = await fetchPack(ref, tag, staging, env);
    assertCompatible(`${ref.id}@${tag ?? commit}`, manifest, env.archonVersion);
    // `owner/plugin:entrypoint` is the public identity, so one owner cannot have
    // two installed packs with the same name. GitHub owners are case-insensitive.
    const clash = receipts.find(
      receipt =>
        receipt.id !== ref.id &&
        receipt.manifest.kind === 'workflow-pack' &&
        receipt.manifest.name === manifest.name &&
        receipt.id.split('/')[0].toLowerCase() === ref.owner.toLowerCase()
    );
    if (clash) {
      throw new Error(
        `${ref.id} and ${clash.id} are both workflow packs named ${ref.owner}/${manifest.name}. Remove one first: archon plugin remove ${clash.id}`
      );
    }
    // The fetched commit is the one installed. If the ref moved back to the installed
    // commit between `ls-remote` and the fetch, the same rule applies.
    if (await settleSameCommit(commit, manifest)) return;
    assertPackTree(ref, manifest, files);

    // Git writes the plugin directory, with its executable bits, from the one commit.
    const stagedTree = join(staging, 'tree');
    const indexEnv = { GIT_INDEX_FILE: join(staging, 'index') };
    await git(['--git-dir', gitDir, 'read-tree', `${commit}:${prefix}`], indexEnv);
    await mkdir(stagedTree);
    await git(['--git-dir', gitDir, '--work-tree', stagedTree, 'checkout-index', '-a'], indexEnv);

    const tree = packTreePath(env.pluginsDir, ref.id, commit);
    await mkdir(dirname(tree), { recursive: true });
    // No receipt points at this commit (settleSameCommit returned above), so a tree
    // here is left over from an interrupted install and nothing reads it.
    await rm(tree, { recursive: true, force: true });
    await rename(stagedTree, tree);
    // The receipt is written last, so a reader sees either the old complete tree or
    // the new one, never a receipt pointing at a partial tree. If it cannot be written,
    // the new tree has no owner; no receipt points at this commit, so removing it leaves
    // the previous install exactly as it was.
    try {
      await writeReceipt({
        schemaVersion: 1,
        id: ref.id,
        manifest,
        ...(tag ? { tag } : {}),
        commit,
        installedAt: new Date().toISOString(),
      });
    } catch (error) {
      await rm(tree, { recursive: true, force: true });
      throw error;
    }
    // Runs already started are unaffected: capture copied the bytes they run.
    if (previous) {
      await rm(packTreePath(env.pluginsDir, ref.id, previous.commit), {
        recursive: true,
        force: true,
      });
    }

    const at = `${tag ?? 'default branch'} (commit ${commit})`;
    console.log(
      previous
        ? `Updated ${ref.id}: ${previous.tag ?? 'default branch'} (commit ${previous.commit}) -> ${at}`
        : `Installed ${ref.id} from github.com/${ref.owner}/${ref.repo} ${at}`
    );
    for (const name of Object.keys(manifest.entrypoints)) {
      console.log(`  ${ref.owner}/${manifest.name}:${name}`);
    }
    console.log(`  These workflows and their scripts were published by ${ref.owner}.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
