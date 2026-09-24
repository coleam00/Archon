/**
 * `archon plugin install | update | remove | list | copy`.
 *
 * GitHub is the registry: a plugin is `owner/repo[/path]` (where its
 * `archon-plugin.json` lives) and a version is a tag. Resolution uses
 * `git ls-remote`, the `releases/latest` redirect, raw file and codeload
 * downloads, never the GitHub API, so it needs no token and has no API rate
 * limit.
 *
 * - `kind: forge`: the executable comes from the release assets and lands in
 *   the directory forge discovery scans. No `@tag` means the latest release.
 * - `kind: workflow-pack`: the plugin subtree of the commit's tarball becomes
 *   one installed tree that workflow discovery reads. No `@tag` means the
 *   default branch head, frozen as a commit.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execFileAsync } from '@archon/git';
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
  type WorkflowPackManifest,
} from '@archon/plugin-manifest';
import {
  packTreePath,
  readReceipts,
  receiptPath,
  RECEIPT_FILE,
} from '@archon/plugin-manifest/store';
import { readTar } from './plugin-tar';

export interface PluginEnvironment {
  /** `ARCHON_HOME/plugins`, the directory forge discovery scans. */
  pluginsDir: string;
  archonVersion: string;
  /** The project `copy` writes into: the working directory, or `--cwd`. */
  projectDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaced only by tests, which serve a GitHub fixture over local HTTP. */
  githubUrl?: string;
  rawUrl?: string;
  codeloadUrl?: string;
}

interface PluginRef {
  owner: string;
  repo: string;
  path: string[];
  /** `owner/repo[/path]` */
  id: string;
  tag?: string;
}

/** What a ref resolved to: the commit, and the manifest at that commit. */
interface ResolvedSource {
  tag?: string;
  commit: string;
  manifest: PluginManifest;
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
 * pack installs that commit; a forge plugin's binaries exist only as release
 * assets, so it moves on to the latest release. `update` already knows the
 * kind from its receipt.
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
    return { tag, commit, manifest: await fetchManifest(ref, commit, rawUrl) };
  };
  if (ref.tag) return atTag(ref.tag);
  if (kind === 'forge') return atTag(await latestReleaseTag(ref, githubUrl));
  const commit = await resolveHeadCommit(ref, githubUrl);
  const manifest = await fetchManifest(ref, commit, rawUrl);
  if (manifest.kind === 'forge') return atTag(await latestReleaseTag(ref, githubUrl));
  return { commit, manifest };
}

function assertCompatible(ref: PluginRef, source: ResolvedSource, archonVersion: string): void {
  const range = source.manifest.compatibility?.archon;
  if (range && !Bun.semver.satisfies(archonVersion, range)) {
    throw new Error(
      `${ref.id}@${source.tag ?? source.commit} requires Archon ${range}; this is Archon ${archonVersion}`
    );
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
  source: ResolvedSource & { tag: string; manifest: ForgeManifest },
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

/**
 * The plugin subtree of a commit tarball, as relative path -> file.
 *
 * Refuses, by name, every entry the tree could not hold faithfully: any
 * absolute or `..` name in the archive (its place is ambiguous), and any
 * symlink, hard link or special file inside the plugin. Either would let
 * discovery or run capture read something other than the files at this commit.
 */
function packFiles(
  tarball: Uint8Array<ArrayBuffer>,
  ref: PluginRef
): Map<string, { data: Uint8Array; executable: boolean }> {
  const entries = readTar(Bun.gunzipSync(tarball));
  const top = entries[0]?.path.split('/')[0];
  const files = new Map<string, { data: Uint8Array; executable: boolean }>();
  if (!top) throw new Error(`The tarball of ${ref.owner}/${ref.repo} is empty`);
  const root = [top, ...ref.path].join('/');
  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (segments[0] !== top || segments.some(s => s === '' || s === '.' || s === '..')) {
      throw new Error(`Refusing ${ref.id}: the archive entry "${entry.path}" escapes its root`);
    }
    if (entry.path !== root && !entry.path.startsWith(`${root}/`)) continue;
    const relative = entry.path.slice(root.length + 1);
    if (entry.kind === 'directory') continue;
    if (entry.kind !== 'file') {
      throw new Error(
        `Refusing ${ref.id}: "${relative}" is a ${entry.kind}; a workflow pack may contain only regular files`
      );
    }
    files.set(relative, { data: entry.data, executable: entry.executable });
  }
  return files;
}

/** Proves the tree is the pack its manifest describes before anything is written. */
function assertPackTree(
  ref: PluginRef,
  manifest: WorkflowPackManifest,
  files: ReadonlyMap<string, { data: Uint8Array }>
): void {
  const inTree = files.get(PLUGIN_MANIFEST_FILE);
  let treeManifest: unknown;
  try {
    treeManifest = inTree ? JSON.parse(new TextDecoder().decode(inTree.data)) : undefined;
  } catch {
    treeManifest = undefined;
  }
  // Discovery reads entrypoints from the installed tree, so it must hold the
  // manifest this install was checked against.
  if (!isDeepStrictEqual(pluginManifestSchema.safeParse(treeManifest).data, manifest)) {
    throw new Error(
      `Refusing ${ref.id}: the tarball's ${PLUGIN_MANIFEST_FILE} differs from the one at the same commit`
    );
  }
  for (const [name, path] of Object.entries(manifest.entrypoints)) {
    const folder = `${path.split('/')[0]}/`;
    const yamls = [...files.keys()].filter(
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
  source: ResolvedSource & { manifest: WorkflowPackManifest },
  receipts: PluginReceipt[],
  previous: PluginReceipt | undefined,
  env: PluginEnvironment
): Promise<void> {
  const { tag, commit, manifest } = source;
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
  if (previous?.commit === commit && previous.tag === tag) {
    console.log(`${ref.id} is already at ${tag ?? 'the default branch head'} (commit ${commit})`);
    return;
  }

  const codeloadUrl = env.codeloadUrl ?? 'https://codeload.github.com';
  const tarballUrl = `${codeloadUrl}/${ref.owner}/${ref.repo}/tar.gz/${commit}`;
  const tarball = await download(tarballUrl);
  if (!tarball) throw new Error(`${tarballUrl} returned 404`);
  const files = packFiles(tarball, ref);
  assertPackTree(ref, manifest, files);

  const receipt: PluginReceipt = pluginReceiptSchema.parse({
    schemaVersion: 1,
    id: ref.id,
    manifest,
    ...(tag ? { tag } : {}),
    commit,
    installedAt: new Date().toISOString(),
  });
  const tree = packTreePath(env.pluginsDir, ref.id, commit);
  const stagedTree = join(dirname(tree), `.${commit}.${randomBytes(6).toString('hex')}.partial`);
  const receiptFile = receiptPath(env.pluginsDir, ref.id);
  const stagedReceipt = join(dirname(receiptFile), stagingName(RECEIPT_FILE));
  await mkdir(dirname(receiptFile), { recursive: true });
  try {
    for (const [relative, file] of files) {
      const target = join(stagedTree, ...relative.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644 });
    }
    // A tree with no receipt pointing at it is left over from an interrupted
    // install of this same commit; nothing reads it.
    await rm(tree, { recursive: true, force: true });
    await rename(stagedTree, tree);
    // The receipt is written last, so a reader sees either the old complete
    // tree or the new one, never a receipt pointing at a partial tree.
    await writeFile(stagedReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(stagedReceipt, receiptFile);
  } finally {
    await rm(stagedTree, { recursive: true, force: true });
    await rm(stagedReceipt, { force: true });
  }
  // Runs already started are unaffected: capture copied the bytes they run.
  if (previous && previous.commit !== commit) {
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
  if (previous && previous.manifest.kind !== source.manifest.kind) {
    throw new Error(
      `${ref.id} is now a ${source.manifest.kind} plugin, not ${previous.manifest.kind}. Remove it, then install it again.`
    );
  }
  assertCompatible(ref, source, env.archonVersion);
  const { manifest } = source;
  if (manifest.kind === 'forge') {
    // resolveSource always names the release a forge plugin came from.
    if (!source.tag) throw new Error(`${ref.id} resolved without a release tag`);
    await installForge(ref, { ...source, tag: source.tag, manifest }, receipts, previous, env);
  } else {
    await installPack(ref, { ...source, manifest }, receipts, previous, env);
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
  const target = join(env.projectDir, '.archon', 'workflows', receipt.manifest.name);
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
