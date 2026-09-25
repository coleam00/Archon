/**
 * `archon plugin install | update | remove | list | copy`.
 *
 * GitHub is the registry: a plugin is `owner/repo[/path]` (where its
 * `archon-plugin.json` lives) and a version is a tag. Resolution uses
 * `git ls-remote`, the `releases/latest` redirect, raw file downloads and
 * `git fetch`, never the GitHub API, so it needs no token and has no API rate
 * limit. Git's own credential setup applies to its calls; the raw manifest read
 * is unauthenticated, so a private repository cannot be installed.
 *
 * - `kind: forge`: the executable comes from the release assets and lands in
 *   the directory forge discovery scans. No `@tag` means the latest release.
 * - `kind: workflow-pack`: the tag, or the default branch head, is fetched with
 *   git at depth 1 and the plugin directory of that commit becomes one installed
 *   tree that workflow discovery reads.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileAsync, findRepoRoot } from '@archon/git';
import {
  describeIssues,
  forgeReleaseAsset,
  isForgeReceipt,
  PLUGIN_MANIFEST_FILE,
  pluginManifestSchema,
  pluginReceiptSchema,
  type ForgeManifest,
  type PluginManifest,
  type PluginReceipt,
  type WorkflowPackReceipt,
  type WorkflowPackManifest,
  workflowPackManifestSchema,
} from '@archon/plugin-manifest';
import {
  packTreePath,
  readReceipts,
  receiptPath,
  RECEIPT_FILE,
} from '@archon/plugin-manifest/store';

export interface PluginEnvironment {
  /** `ARCHON_HOME/plugins`, the directory forge discovery scans. */
  pluginsDir: string;
  archonVersion: string;
  /** Where `copy` starts looking for its project: the working directory, or `--cwd`. */
  projectDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaced only by tests, which serve a GitHub fixture from local HTTP and a file URL. */
  githubUrl?: string;
  rawUrl?: string;
}

interface PluginRef {
  owner: string;
  repo: string;
  path: string[];
  /** `owner/repo[/path]` */
  id: string;
  tag?: string;
}

/**
 * What a ref resolved to: the commit and the manifest at that commit. A forge plugin's
 * files are release assets, so it always resolves to a tag; a pack may resolve to the
 * default branch head.
 */
type ResolvedSource =
  | { kind: 'forge'; tag: string; commit: string; manifest: ForgeManifest }
  | { kind: 'workflow-pack'; tag?: string; commit: string; manifest: WorkflowPackManifest };

function resolved(
  tag: string | undefined,
  commit: string,
  manifest: PluginManifest
): ResolvedSource {
  if (manifest.kind === 'workflow-pack') {
    return { kind: manifest.kind, ...(tag !== undefined ? { tag } : {}), commit, manifest };
  }
  if (tag === undefined) throw new Error(`forge plugin ${manifest.name} resolved without a tag`);
  return { kind: manifest.kind, tag, commit, manifest };
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// Every part becomes a directory under the receipts tree or a URL path segment,
// so `.`/`..` and separators are refused here rather than escaping either.
export function parsePluginRef(input: string): PluginRef {
  const at = input.lastIndexOf('@');
  const tag = at === -1 ? undefined : input.slice(at + 1);
  const [owner = '', repo = '', ...path] = (at === -1 ? input : input.slice(0, at)).split('/');
  const segmentsValid = [repo, ...path].every(
    segment => SEGMENT.test(segment) && segment !== '.' && segment !== '..'
  );
  if (!OWNER.test(owner) || !segmentsValid || (tag !== undefined && !TAG.test(tag))) {
    throw new Error(
      `Invalid plugin "${input}". Expected owner/repo[/path][@tag], for example coleam00/Archon/plugins/forge-github`
    );
  }
  return { owner, repo, path, id: [owner, repo, ...path].join('/'), tag };
}

/**
 * A name forge discovery never treats as a plugin: it does not start with
 * `archon-forge-`, so a half-written binary is never executed by a concurrent scan.
 */
export function stagingName(fileName: string): string {
  return `.${fileName}.${randomBytes(6).toString('hex')}.partial`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function latestReleaseTag(ref: PluginRef, githubUrl: string): Promise<string> {
  const url = `${githubUrl}/${ref.owner}/${ref.repo}/releases/latest`;
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  const match =
    response.status >= 300 && response.status < 400 && location
      ? /\/releases\/tag\/([^/]+)$/.exec(new URL(location, url).pathname)
      : null;
  const tag = match ? decodeURIComponent(match[1]) : undefined;
  if (!tag || !TAG.test(tag)) {
    throw new Error(
      `Could not find the latest release of ${ref.owner}/${ref.repo} (${url} returned ${response.status}). Name a release tag: ${ref.id}@<tag>`
    );
  }
  return tag;
}

async function lsRemote(
  ref: PluginRef,
  patterns: string[],
  githubUrl: string
): Promise<Map<string, string>> {
  const remote = `${githubUrl}/${ref.owner}/${ref.repo}.git`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-remote', remote, ...patterns],
      // Never prompt: a missing or private repository must fail, not wait for input.
      { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    ));
  } catch (error) {
    throw new Error(`Could not read refs of ${remote}: ${(error as Error).message}`);
  }
  return new Map(
    stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, name] = line.split('\t');
        return [name, sha] as const;
      })
  );
}

async function resolveTagCommit(ref: PluginRef, tag: string, githubUrl: string): Promise<string> {
  const refs = await lsRemote(ref, [`refs/tags/${tag}`, `refs/tags/${tag}^{}`], githubUrl);
  // An annotated tag lists the tag object and its peeled commit; prefer the commit.
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit) throw new Error(`${ref.owner}/${ref.repo} has no tag ${tag}`);
  return commit;
}

async function resolveHeadCommit(ref: PluginRef, githubUrl: string): Promise<string> {
  const commit = (await lsRemote(ref, ['HEAD'], githubUrl)).get('HEAD');
  if (!commit) throw new Error(`${ref.owner}/${ref.repo} has no default branch`);
  return commit;
}

async function fetchManifest(
  ref: PluginRef,
  commit: string,
  rawUrl: string
): Promise<PluginManifest> {
  const url = `${rawUrl}/${ref.owner}/${ref.repo}/${commit}/${[...ref.path, PLUGIN_MANIFEST_FILE].join('/')}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `No ${PLUGIN_MANIFEST_FILE} for ${ref.id} at commit ${commit} (${url} returned ${response.status})`
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`${url} is not valid JSON`);
  }
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid plugin manifest ${url}: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Resolve a ref to one commit and its manifest. A named tag is used as given.
 * Without one, the manifest at the default branch head decides: a workflow
 * pack goes on to fetch that ref, and the commit the fetch returns is the one
 * installed; a forge plugin's binaries exist only as release assets, so it moves
 * on to the latest release. `update` already knows the kind from its receipt.
 */
async function resolveSource(
  ref: PluginRef,
  kind: PluginManifest['kind'] | undefined,
  env: PluginEnvironment
): Promise<ResolvedSource> {
  const githubUrl = env.githubUrl ?? 'https://github.com';
  const rawUrl = env.rawUrl ?? 'https://raw.githubusercontent.com';
  const atTag = async (tag: string): Promise<ResolvedSource> => {
    const commit = await resolveTagCommit(ref, tag, githubUrl);
    return resolved(tag, commit, await fetchManifest(ref, commit, rawUrl));
  };
  if (ref.tag) return atTag(ref.tag);
  if (kind === 'forge') return atTag(await latestReleaseTag(ref, githubUrl));
  const commit = await resolveHeadCommit(ref, githubUrl);
  const manifest = await fetchManifest(ref, commit, rawUrl);
  if (manifest.kind === 'forge') return atTag(await latestReleaseTag(ref, githubUrl));
  return resolved(undefined, commit, manifest);
}

function assertCompatible(label: string, manifest: PluginManifest, archonVersion: string): void {
  const range = manifest.compatibility?.archon;
  if (range && !Bun.semver.satisfies(archonVersion, range)) {
    throw new Error(`${label} requires Archon ${range}; this is Archon ${archonVersion}`);
  }
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const response = await fetch(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Reads the `sha256sum` output that release.yml publishes as checksums.txt. */
function expectedDigest(checksums: string, asset: string): string | undefined {
  for (const line of checksums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+?)\r?$/.exec(line);
    if (match?.[2] === asset) return match[1];
  }
  return undefined;
}

async function installForge(
  ref: PluginRef,
  source: Extract<ResolvedSource, { kind: 'forge' }>,
  receipts: PluginReceipt[],
  previous: PluginReceipt | undefined,
  env: PluginEnvironment
): Promise<void> {
  const { tag, commit, manifest } = source;
  const githubUrl = env.githubUrl ?? 'https://github.com';
  const platform = env.platform ?? process.platform;
  const fileName = `${manifest.executable}${platform === 'win32' ? '.exe' : ''}`;
  const target = join(env.pluginsDir, fileName);
  const owner = receipts.find(
    receipt => isForgeReceipt(receipt) && receipt.files.some(f => f.path === fileName)
  );
  if (owner && owner.id !== ref.id) {
    throw new Error(
      `${target} belongs to ${owner.id}. Remove it first: archon plugin remove ${owner.id}`
    );
  }
  if (!owner && (await pathExists(target))) {
    throw new Error(
      `${target} exists but was not installed by archon plugin. Move or delete it, then retry.`
    );
  }

  const bunTarget = `bun-${platform === 'win32' ? 'windows' : platform}-${env.arch ?? process.arch}`;
  const asset = forgeReleaseAsset(manifest.executable, bunTarget);
  const releaseUrl = `${githubUrl}/${ref.owner}/${ref.repo}/releases/download/${encodeURIComponent(tag)}`;
  const bytes = await download(`${releaseUrl}/${asset}`);
  if (!bytes) {
    throw new Error(`Release ${tag} of ${ref.owner}/${ref.repo} has no ${asset} for this platform`);
  }
  const checksums = await download(`${releaseUrl}/checksums.txt`);
  if (!checksums)
    throw new Error(`Release ${tag} of ${ref.owner}/${ref.repo} has no checksums.txt`);
  const expected = expectedDigest(new TextDecoder().decode(checksums), asset);
  if (!expected) throw new Error(`checksums.txt of release ${tag} has no entry for ${asset}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected) {
    throw new Error(
      `${asset} does not match checksums.txt of release ${tag} (expected ${expected}, got ${digest}). Nothing was installed.`
    );
  }

  const receipt: PluginReceipt = pluginReceiptSchema.parse({
    schemaVersion: 1,
    id: ref.id,
    manifest,
    tag,
    commit,
    installedAt: new Date().toISOString(),
    files: [{ path: fileName, sha256: digest }],
  });
  const receiptFile = receiptPath(env.pluginsDir, ref.id);
  const stagedBinary = join(env.pluginsDir, stagingName(fileName));
  const stagedReceipt = join(dirname(receiptFile), stagingName(RECEIPT_FILE));
  await mkdir(dirname(receiptFile), { recursive: true });
  try {
    await writeFile(stagedBinary, bytes);
    await chmod(stagedBinary, 0o755);
    await writeFile(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    // Receipt first: if the binary rename then fails, the receipt still owns the
    // name and `update` or `remove` can recover. The other order could strand a
    // binary no receipt owns, which every later install would refuse to replace.
    await rename(stagedReceipt, receiptFile);
    await rename(stagedBinary, target);
  } finally {
    await rm(stagedBinary, { force: true });
    await rm(stagedReceipt, { force: true });
  }
  if (previous && isForgeReceipt(previous)) {
    for (const file of previous.files) {
      if (file.path !== fileName) await rm(join(env.pluginsDir, file.path), { force: true });
    }
  }

  const from = `github.com/${ref.owner}/${ref.repo} ${tag} (commit ${commit})`;
  console.log(
    previous
      ? `Updated ${ref.id}: ${previous.tag} (commit ${previous.commit}) -> ${from}`
      : `Installed ${ref.id} from ${from}`
  );
  console.log(`  ${target}  sha256 ${digest}`);
  console.log(`  This runs code published by ${ref.owner}.`);
}

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
  const commit = (
    await git(['--git-dir', gitDir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
  ).trim();
  const prefix = ref.path.length > 0 ? `${ref.path.join('/')}/` : '';

  const files = new Set<string>();
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
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode] = record.slice(0, tab).split(' ');
    const relative = record.slice(tab + 1).slice(prefix.length);
    if (
      relative.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
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
    files.add(relative);
  }

  // The raw manifest read that chose this path was at the resolved commit; the fetched
  // commit's own manifest is the one installed, and it must still describe a pack.
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
  return { gitDir, commit, prefix, manifest: parsed.data, files };
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

async function installPack(
  ref: PluginRef,
  source: Extract<ResolvedSource, { kind: 'workflow-pack' }>,
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

async function installPlugin(
  ref: PluginRef,
  mode: 'install' | 'update',
  env: PluginEnvironment
): Promise<void> {
  const receipts = await readReceipts(env.pluginsDir);
  const previous = receipts.find(receipt => receipt.id === ref.id);
  if (mode === 'install' && previous) {
    throw new Error(
      `${ref.id} is already installed at ${previous.tag ?? 'the default branch head'} (${previous.commit}). Use: archon plugin update ${ref.id}`
    );
  }
  if (mode === 'update' && !previous) {
    throw new Error(`${ref.id} is not installed. Use: archon plugin install ${ref.id}`);
  }

  // Every check below runs before anything is written, so any failure leaves
  // the previous install exactly as it was.
  const source = await resolveSource(ref, previous?.manifest.kind, env);
  if (previous && previous.manifest.kind !== source.kind) {
    throw new Error(
      `${ref.id} is now a ${source.kind} plugin, not ${previous.manifest.kind}. Remove it, then install it again.`
    );
  }
  if (source.kind === 'forge') {
    assertCompatible(`${ref.id}@${source.tag}`, source.manifest, env.archonVersion);
    await installForge(ref, source, receipts, previous, env);
  } else {
    // The kind check above means an existing receipt here is a pack receipt.
    const packReceipt = previous && !isForgeReceipt(previous) ? previous : undefined;
    await installPack(ref, source, receipts, packReceipt, env);
  }
}

async function removePlugin(ref: PluginRef, env: PluginEnvironment): Promise<void> {
  const receipt = (await readReceipts(env.pluginsDir)).find(candidate => candidate.id === ref.id);
  if (!receipt) throw new Error(`${ref.id} is not installed`);
  let removed: string;
  if (isForgeReceipt(receipt)) {
    for (const file of receipt.files) await rm(join(env.pluginsDir, file.path), { force: true });
    removed = receipt.files.map(file => file.path).join(', ');
  } else {
    removed = packTreePath(env.pluginsDir, receipt.id, receipt.commit);
    await rm(removed, { recursive: true, force: true });
  }
  await rm(receiptPath(env.pluginsDir, ref.id));
  console.log(`Removed ${ref.id}: ${removed}`);
}

/** Makes an ordinary project copy of an installed pack; the copy is the project's from then on. */
async function copyPlugin(ref: PluginRef, env: PluginEnvironment): Promise<void> {
  const receipt = (await readReceipts(env.pluginsDir)).find(candidate => candidate.id === ref.id);
  if (!receipt) throw new Error(`${ref.id} is not installed`);
  if (receipt.manifest.kind !== 'workflow-pack') {
    throw new Error(`${ref.id} is a ${receipt.manifest.kind} plugin; only workflow packs copy`);
  }
  // Where discovery reads project workflows: the repository root, not the subdirectory
  // the command ran in. A folder project has no repository; its directory is the project.
  const project = (await findRepoRoot(env.projectDir)) ?? env.projectDir;
  const target = join(project, '.archon', 'workflows', receipt.manifest.name);
  if (await pathExists(target)) {
    throw new Error(`${target} already exists. Move or delete it, then retry.`);
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(packTreePath(env.pluginsDir, receipt.id, receipt.commit), target, { recursive: true });
  console.log(`Copied ${ref.id} (commit ${receipt.commit}) to ${target}`);
  console.log(
    '  Its workflows are now project workflows under their own names. `archon plugin update` does not change this copy.'
  );
}

async function listPlugins(env: PluginEnvironment): Promise<void> {
  const receipts = await readReceipts(env.pluginsDir);
  if (receipts.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  for (const receipt of receipts) {
    const archon = receipt.manifest.compatibility?.archon ?? 'any';
    console.log(
      `${receipt.id}  ${receipt.manifest.kind}  ${receipt.tag ?? '-'}  ${receipt.commit.slice(0, 12)}  archon ${archon}`
    );
  }
}

const USAGE =
  'Usage: archon plugin install <owner/repo[/path][@tag]> | update <id>[@tag] | remove <id> | copy <id> | list';

export async function pluginCommand(
  subcommand: string | undefined,
  args: readonly string[],
  env: PluginEnvironment
): Promise<number> {
  try {
    // Exact arity: an ignored extra argument would install something the
    // operator did not ask for, or silently drop a second plugin.
    if (subcommand === 'list' && args.length === 0) {
      await listPlugins(env);
      return 0;
    }
    const [target] = args;
    if (
      !target ||
      args.length !== 1 ||
      !['install', 'update', 'remove', 'copy'].includes(subcommand ?? '')
    ) {
      console.error(USAGE);
      return 1;
    }
    const ref = parsePluginRef(target);
    if (subcommand === 'remove' || subcommand === 'copy') {
      if (ref.tag) throw new Error(`${subcommand} takes a plugin id without @tag: ${ref.id}`);
      await (subcommand === 'remove' ? removePlugin(ref, env) : copyPlugin(ref, env));
    } else {
      await installPlugin(ref, subcommand === 'install' ? 'install' : 'update', env);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    return 1;
  }
}
