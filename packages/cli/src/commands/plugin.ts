/**
 * `archon plugin install | update | remove | list`.
 *
 * GitHub is the registry: a plugin is `owner/repo[/path]` (where its
 * `archon-plugin.json` lives) and a version is a release tag. Resolution uses
 * `git ls-remote` and the `releases/latest` redirect, never the GitHub API, so
 * it needs no token and has no API rate limit. Only `kind: forge` installs
 * today: its executable comes from the release assets and lands in the
 * directory forge discovery scans.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFileAsync } from '@archon/git';
import {
  forgeReleaseAsset,
  PLUGIN_MANIFEST_FILE,
  pluginManifestSchema,
  pluginReceiptSchema,
  type PluginManifest,
  type PluginReceipt,
} from '@archon/plugin-manifest';

export interface PluginEnvironment {
  /** `ARCHON_HOME/plugins`, the directory forge discovery scans. */
  pluginsDir: string;
  archonVersion: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Replaced only by tests, which serve a release fixture over local HTTP. */
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

const RECEIPT_FILE = 'receipt.json';
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

function receiptPath(pluginsDir: string, id: string): string {
  return join(pluginsDir, 'installed', ...id.split('/'), RECEIPT_FILE);
}

/**
 * A name forge discovery never treats as a plugin: it does not start with
 * `archon-forge-`, so a half-written binary is never executed by a concurrent scan.
 */
export function stagingName(fileName: string): string {
  return `.${fileName}.${randomBytes(6).toString('hex')}.partial`;
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

async function readReceipts(pluginsDir: string): Promise<PluginReceipt[]> {
  const root = join(pluginsDir, 'installed');
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const receipts: PluginReceipt[] = [];
  for (const entry of entries.sort()) {
    if (basename(entry) !== RECEIPT_FILE) continue;
    const file = join(root, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read plugin receipt ${file}: ${(error as Error).message}`);
    }
    const parsed = pluginReceiptSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid plugin receipt ${file}: ${issues(parsed.error)}`);
    }
    receipts.push(parsed.data);
  }
  return receipts;
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

async function resolveTagCommit(ref: PluginRef, tag: string, githubUrl: string): Promise<string> {
  const remote = `${githubUrl}/${ref.owner}/${ref.repo}.git`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['ls-remote', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
      // Never prompt: a missing or private repository must fail, not wait for input.
      { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    ));
  } catch (error) {
    throw new Error(`Could not read tags of ${remote}: ${(error as Error).message}`);
  }
  const refs = new Map(
    stdout
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [sha, name] = line.split('\t');
        return [name, sha] as const;
      })
  );
  // An annotated tag lists the tag object and its peeled commit; prefer the commit.
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit) throw new Error(`${ref.owner}/${ref.repo} has no tag ${tag}`);
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
  if (!parsed.success) throw new Error(`Invalid plugin manifest ${url}: ${issues(parsed.error)}`);
  return parsed.data;
}

async function download(url: string): Promise<Uint8Array | undefined> {
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
  mode: 'install' | 'update',
  env: PluginEnvironment
): Promise<void> {
  const githubUrl = env.githubUrl ?? 'https://github.com';
  const platform = env.platform ?? process.platform;
  const receipts = await readReceipts(env.pluginsDir);
  const previous = receipts.find(receipt => receipt.id === ref.id);
  if (mode === 'install' && previous) {
    throw new Error(
      `${ref.id} is already installed at ${previous.tag} (${previous.commit}). Use: archon plugin update ${ref.id}`
    );
  }
  if (mode === 'update' && !previous) {
    throw new Error(`${ref.id} is not installed. Use: archon plugin install ${ref.id}`);
  }

  // Every check below runs before anything is written, so any failure leaves
  // the previous install exactly as it was.
  const tag = ref.tag ?? (await latestReleaseTag(ref, githubUrl));
  const commit = await resolveTagCommit(ref, tag, githubUrl);
  const manifest = await fetchManifest(
    ref,
    commit,
    env.rawUrl ?? 'https://raw.githubusercontent.com'
  );
  const range = manifest.compatibility?.archon;
  if (range && !Bun.semver.satisfies(env.archonVersion, range)) {
    throw new Error(
      `${ref.id}@${tag} requires Archon ${range}; this is Archon ${env.archonVersion}`
    );
  }

  const fileName = `${manifest.executable}${platform === 'win32' ? '.exe' : ''}`;
  const target = join(env.pluginsDir, fileName);
  const owner = receipts.find(receipt => receipt.files.some(file => file.path === fileName));
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
  for (const file of previous?.files ?? []) {
    if (file.path !== fileName) await rm(join(env.pluginsDir, file.path), { force: true });
  }

  const source = `github.com/${ref.owner}/${ref.repo} ${tag} (commit ${commit})`;
  console.log(
    previous
      ? `Updated ${ref.id}: ${previous.tag} (commit ${previous.commit}) -> ${source}`
      : `Installed ${ref.id} from ${source}`
  );
  console.log(`  ${target}  sha256 ${digest}`);
  console.log(`  This runs code published by ${ref.owner}.`);
}

async function removePlugin(ref: PluginRef, env: PluginEnvironment): Promise<void> {
  const receipt = (await readReceipts(env.pluginsDir)).find(candidate => candidate.id === ref.id);
  if (!receipt) throw new Error(`${ref.id} is not installed`);
  for (const file of receipt.files) await rm(join(env.pluginsDir, file.path), { force: true });
  await rm(receiptPath(env.pluginsDir, ref.id));
  console.log(`Removed ${ref.id}: ${receipt.files.map(file => file.path).join(', ')}`);
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
      `${receipt.id}  ${receipt.manifest.kind}  ${receipt.tag}  ${receipt.commit.slice(0, 12)}  archon ${archon}`
    );
  }
}

const USAGE =
  'Usage: archon plugin install <owner/repo[/path][@tag]> | update <id>[@tag] | remove <id> | list';

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
      !['install', 'update', 'remove'].includes(subcommand ?? '')
    ) {
      console.error(USAGE);
      return 1;
    }
    const ref = parsePluginRef(target);
    if (subcommand === 'remove') {
      if (ref.tag) throw new Error(`remove takes a plugin id without @tag: ${ref.id}`);
      await removePlugin(ref, env);
    } else {
      await installForge(ref, subcommand === 'install' ? 'install' : 'update', env);
    }
    return 0;
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    return 1;
  }
}
