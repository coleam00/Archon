import { createReleaseRepo, serveFixtureGit } from '../test-support/plugin-fixture';
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverPlugins } from '@archon/forge/discovery';
import { compileDiscoveryPlugin } from '@archon/forge/test-fixtures';
import { removeTempTree, skipCompiledBinaryTests, trackTempRoots } from '@archon/paths/test-utils';
import { receiptPath } from '@archon/plugin-manifest/store';
import { parsePluginRef, pluginCommand, stagingName, type PluginEnvironment } from './plugin';

// A local stand-in for GitHub: the repository is served over git's dumb HTTP
// protocol (so `git ls-remote` runs for real), next to the `releases/latest`
// redirect, release downloads and raw manifest files the installer reads.
interface Release {
  assets: Record<string, Uint8Array>;
  /** Defaults to the correct sha256sum listing of `assets`. */
  checksums?: string;
}

const ID = 'owner/repo/plugins/forge-github';
const tempRoot = trackTempRoots();
const hostExe = process.platform === 'win32' ? '.exe' : '';
const hostAsset = `archon-forge-github-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${hostExe}`;

let fixtureRoot: string;
let server: ReturnType<typeof Bun.serve>;
let pluginBinary: Uint8Array;
const commits = new Map<string, string>();
const manifests = new Map<string, unknown>();
const releases = new Map<string, Release>();
// Most of the suite needs the compiled fixture, which only the v1.0.0 release carries.
const skipCompiled = skipCompiledBinaryTests();
const latestTag = 'v1.0.0';
// For the test that installs the ~86 MB compiled fixture (only v1.0.0 carries it; every
// other release is a few bytes). That write has taken over 20 s on Windows CI, and a test
// that times out keeps running after `afterEach` has deleted its temp home.
const FIXTURE_WRITE_BUDGET_MS = 60_000;

const manifest = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: 'forge',
  name: 'forge-github',
  description: 'fixture',
  executable: 'archon-forge-github',
  ...extra,
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const checksumsFor = (assets: Record<string, Uint8Array>): string =>
  Object.entries(assets)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
    .join('');

// Compiles the same forge fixture as forge's discovery.test.ts, so it takes the same
// compile-sized budget.
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'plugin-install-fixture-'));
  if (!skipCompiled) {
    // A real executable that answers forge discovery's metadata handshake as `github`.
    const binaryPath = compileDiscoveryPlugin(fixtureRoot);
    pluginBinary = new Uint8Array(await readFile(binaryPath));
    releases.set('v1.0.0', { assets: { [hostAsset]: pluginBinary } });
  }

  const repo = join(fixtureRoot, 'repo');
  const fixtureCommits = await createReleaseRepo(repo, [
    { tag: 'pack-0.1.0' },
    { tag: 'v1.0.0', annotated: true },
    { tag: 'v2.0.0' },
    { tag: 'v3.0.0' },
    { tag: 'v4.0.0' },
  ]);
  for (const [tag, commit] of fixtureCommits) commits.set(tag, commit);

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path === '/owner/repo/releases/latest') {
        return new Response(null, {
          status: 302,
          headers: { location: `/owner/repo/releases/tag/${latestTag}` },
        });
      }
      const gitResponse = await serveFixtureGit(repo, path);
      if (gitResponse) return gitResponse;
      const download = /^\/owner\/repo\/releases\/download\/([^/]+)\/(.+)$/.exec(path);
      if (download) {
        const release = releases.get(download[1]);
        if (!release) return new Response(null, { status: 404 });
        if (download[2] === 'checksums.txt') {
          return new Response(release.checksums ?? checksumsFor(release.assets));
        }
        const asset = release.assets[download[2]];
        return asset ? new Response(asset) : new Response(null, { status: 404 });
      }
      const raw = /^\/raw\/owner\/repo\/([0-9a-f]{40})\/plugins\/[^/]+\/archon-plugin\.json$/.exec(
        path
      );
      const body = raw ? manifests.get(raw[1]) : undefined;
      return body ? Response.json(body) : new Response(null, { status: 404 });
    },
  });

  const commit = (tag: string): string => commits.get(tag) ?? '';
  manifests.set(commit('v1.0.0'), manifest());
  manifests.set(commit('v2.0.0'), manifest());
  manifests.set(commit('v3.0.0'), manifest({ compatibility: { archon: '>=99.0.0' } }));
  manifests.set(commit('v4.0.0'), manifest());
  manifests.set(commit('pack-0.1.0'), {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: 'forge-github',
    description: 'fixture',
    entrypoints: { review: 'review/review.yaml' },
  });
  // On a Windows x64 host both keys are the same asset.
  releases.set('v2.0.0', {
    assets: {
      [hostAsset]: new Uint8Array([2, 2]),
      'archon-forge-github-windows-x64.exe': new Uint8Array([2, 2]),
    },
  });
  releases.set('v3.0.0', { assets: { [hostAsset]: new Uint8Array([3]) } });
  // The asset was replaced after checksums.txt was generated.
  releases.set('v4.0.0', {
    assets: { [hostAsset]: new Uint8Array([4, 4]) },
    checksums: checksumsFor({ [hostAsset]: new Uint8Array([4]) }),
  });
}, 60_000);

afterAll(async () => {
  await server.stop(true);
  await removeTempTree(fixtureRoot);
});

async function environment(overrides: Partial<PluginEnvironment> = {}): Promise<PluginEnvironment> {
  const home = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-install-home-')));
  return {
    pluginsDir: join(home, 'plugins'),
    archonVersion: '0.11.0',
    projectDir: home,
    githubUrl: server.url.origin,
    rawUrl: `${server.url.origin}/raw`,
    ...overrides,
  };
}

async function run(
  env: PluginEnvironment,
  subcommand: string,
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const log = spyOn(console, 'log').mockImplementation(() => undefined);
  const error = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await pluginCommand(subcommand, args, env);
    return {
      code,
      out: log.mock.calls.map(call => call.join(' ')).join('\n'),
      err: error.mock.calls.map(call => call.join(' ')).join('\n'),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

/** Every file under the plugins directory with its bytes, to prove a failure wrote nothing. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return {};
  }
  const files: Record<string, string> = {};
  for (const entry of entries.sort()) {
    try {
      files[entry] = sha256(new Uint8Array(await readFile(join(dir, entry))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
    }
  }
  return files;
}

const receiptOf = async (env: PluginEnvironment): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(receiptPath(env.pluginsDir, ID), 'utf8')) as Record<string, unknown>;

/** Writes `{not json` as `id`'s receipt and returns its path. */
async function breakReceipt(env: PluginEnvironment, id: string): Promise<string> {
  const file = receiptPath(env.pluginsDir, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{not json');
  return file;
}

describe.skipIf(skipCompiled)('archon plugin', () => {
  test(
    'installs the latest release where forge discovery finds it, then updates, lists and removes it',
    async () => {
      const env = await environment();
      const installed = await run(env, 'install', ID);
      expect(installed.err).toBe('');
      expect(installed.code).toBe(0);
      expect(installed.out).toContain(`commit ${commits.get('v1.0.0')}`);

      const receipt = await receiptOf(env);
      expect(receipt).toMatchObject({ id: ID, tag: 'v1.0.0', commit: commits.get('v1.0.0') });
      const discovery = await discoverPlugins({
        config: { scanPath: false },
        pluginsDir: env.pluginsDir,
      });
      expect(discovery.plugins.map(plugin => plugin.metadata.name)).toEqual(['github']);

      // A binary the operator placed by hand is not the receipt's to remove.
      const handPlaced = join(env.pluginsDir, 'archon-forge-other');
      await writeFile(handPlaced, 'mine');

      expect((await run(env, 'install', ID)).err).toContain('already installed');
      const updated = await run(env, 'update', `${ID}@v2.0.0`);
      expect(updated.code).toBe(0);
      expect(updated.out).toContain(`${commits.get('v1.0.0')}) -> `);
      expect(await receiptOf(env)).toMatchObject({ tag: 'v2.0.0', commit: commits.get('v2.0.0') });
      expect(
        new Uint8Array(await readFile(join(env.pluginsDir, `archon-forge-github${hostExe}`)))
      ).toEqual(new Uint8Array([2, 2]));

      const listed = await run(env, 'list');
      expect(listed.out).toBe(
        `${ID}  forge  v2.0.0  ${commits.get('v2.0.0')?.slice(0, 12)}  archon any`
      );

      expect((await run(env, 'remove', ID)).code).toBe(0);
      expect(Object.keys(await snapshot(env.pluginsDir))).toEqual(['archon-forge-other']);
      expect((await run(env, 'list')).out).toBe('No plugins installed.');
    },
    FIXTURE_WRITE_BUDGET_MS
  );

  test('a checksum mismatch fails the update and leaves the previous install untouched', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v2.0.0`)).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'update', `${ID}@v4.0.0`);
    expect(result.code).toBe(1);
    expect(result.err).toContain('does not match checksums.txt');
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test('refuses a platform the release has no asset for, and writes nothing', async () => {
    const env = await environment({ platform: 'linux', arch: 'arm64' });
    if (hostAsset === 'archon-forge-github-linux-arm64') env.arch = 'x64';
    const result = await run(env, 'install', `${ID}@v2.0.0`);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Release v2.0.0 of owner/repo has no archon-forge-github-linux-');
    expect(result.err).toContain('for this platform');
    expect(await snapshot(env.pluginsDir)).toEqual({});
  });

  test('refuses a release whose manifest requires another Archon version', async () => {
    const env = await environment();
    const result = await run(env, 'install', `${ID}@v3.0.0`);
    expect(result.err).toContain('requires Archon >=99.0.0; this is Archon 0.11.0');
    expect(await snapshot(env.pluginsDir)).toEqual({});
  });

  test('never overwrites a forge executable that no receipt owns', async () => {
    const env = await environment();
    await mkdir(env.pluginsDir, { recursive: true });
    await writeFile(join(env.pluginsDir, `archon-forge-github${hostExe}`), 'built by hand');
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'install', ID);
    expect(result.err).toContain('was not installed by archon plugin');
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test("never overwrites another plugin's executable", async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v2.0.0`)).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'install', 'owner/repo/plugins/copy');
    expect(result.err).toContain(`belongs to ${ID}`);
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test('names the executable with .exe on Windows', async () => {
    const env = await environment({ platform: 'win32', arch: 'x64' });
    expect((await run(env, 'install', `${ID}@v2.0.0`)).code).toBe(0);
    expect(Object.keys(await snapshot(env.pluginsDir))[0]).toBe('archon-forge-github.exe');
    expect(await receiptOf(env)).toMatchObject({
      files: [{ path: 'archon-forge-github.exe', sha256: sha256(new Uint8Array([2, 2])) }],
    });
  });

  test('forge discovery does not see a binary under its staging name', async () => {
    const env = await environment();
    await mkdir(env.pluginsDir, { recursive: true });
    const staged = join(env.pluginsDir, stagingName(`archon-forge-github${hostExe}`));
    // Probing these bytes fails the handshake, so a probed staging file shows in `unavailable`.
    await writeFile(staged, new Uint8Array([1]), { mode: 0o755 });
    const stderr = spyOn(process.stderr, 'write');
    try {
      const discovery = await discoverPlugins({
        config: { scanPath: false },
        pluginsDir: env.pluginsDir,
      });
      expect(discovery.plugins).toEqual([]);
      expect(discovery.unavailable).toEqual([]);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  test('update refuses a tag whose manifest is another kind, and copy refuses a forge plugin', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v2.0.0`)).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    expect((await run(env, 'update', `${ID}@pack-0.1.0`)).err).toContain(
      'is now a workflow-pack plugin, not forge'
    );
    expect((await run(env, 'copy', ID)).err).toContain('only workflow packs copy');
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test('refuses malformed plugin ids and extra arguments before touching the network', async () => {
    const env = await environment();
    for (const args of [['install', ID, 'owner/repo/other'], ['list', ID], ['install']]) {
      expect((await run(env, args[0], ...args.slice(1))).err).toContain('Usage: archon plugin');
    }
    for (const target of ['owner', 'owner/../x', 'owner/repo/..', 'owner/repo@', '-x/repo']) {
      expect((await run(env, 'install', target)).err).toContain('Invalid plugin');
    }
  });
});

describe('archon plugin with an unreadable receipt', () => {
  const BROKEN = 'acme/broken';
  const OTHER = 'acme/other';

  /** A hand-written forge receipt for OTHER, with the executable it names. */
  async function installOther(env: PluginEnvironment): Promise<void> {
    const file = receiptPath(env.pluginsDir, OTHER);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: OTHER,
        manifest: {
          schemaVersion: 1,
          kind: 'forge',
          name: 'forge-other',
          description: 'x',
          executable: 'archon-forge-other',
        },
        tag: 'v1.0.0',
        commit: 'a'.repeat(40),
        installedAt: new Date().toISOString(),
        files: [{ path: 'archon-forge-other', sha256: 'b'.repeat(64) }],
      })
    );
    await writeFile(join(env.pluginsDir, 'archon-forge-other'), 'other');
  }

  test('list reports the broken receipt beside the valid plugins', async () => {
    const env = await environment();
    await installOther(env);
    const broken = await breakReceipt(env, BROKEN);
    const listed = await run(env, 'list');
    expect(listed.code).toBe(0);
    expect(listed.out.split('\n')).toEqual([
      `${OTHER}  forge  v1.0.0  ${'a'.repeat(12)}  archon any`,
      `${BROKEN}  unreadable  Invalid JSON in plugin receipt ${broken}. Repair it: archon plugin update ${BROKEN}, or archon plugin remove ${BROKEN}`,
    ]);
  });

  test.each(['acme', 'acme/broken@v1', 'acme/repo/plugins/broken@v1'])(
    'a receipt outside a valid plugin-id location (%s) is reported for deletion by hand',
    async strayId => {
      const env = await environment();
      const stray = await breakReceipt(env, strayId);
      expect((await run(env, 'list')).out).toBe(
        `${strayId}  unreadable  Invalid JSON in plugin receipt ${stray}. It is not where archon plugin writes receipts; delete it by hand`
      );
    }
  );

  test('remove deletes the broken receipt and leaves every file it might name', async () => {
    const env = await environment();
    await installOther(env);
    const broken = await breakReceipt(env, BROKEN);
    const before = await snapshot(env.pluginsDir);
    const removed = await run(env, 'remove', BROKEN);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(`Removed the unreadable receipt of ${BROKEN}: ${broken}`);
    expect(removed.out).toContain('could not be identified and were left in place');
    delete before[join('installed', ...BROKEN.split('/'), 'receipt.json')];
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test('remove and copy of an unrelated plugin still work', async () => {
    const env = await environment();
    await installOther(env);
    const broken = await breakReceipt(env, BROKEN);
    // OTHER is a forge plugin: copy reaching its kind check proves the scan let it through.
    expect((await run(env, 'copy', OTHER)).err).toContain('only workflow packs copy');
    expect((await run(env, 'copy', BROKEN)).err).toContain(
      `Invalid JSON in plugin receipt ${broken}`
    );
    expect((await run(env, 'remove', OTHER)).code).toBe(0);
    expect(Object.keys(await snapshot(env.pluginsDir))).toEqual([
      join('installed', ...BROKEN.split('/'), 'receipt.json'),
    ]);
  });

  test('installing any other plugin refuses, naming the broken receipt and its repair', async () => {
    const env = await environment();
    const broken = await breakReceipt(env, BROKEN);
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'install', `${ID}@v2.0.0`);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`Invalid JSON in plugin receipt ${broken}`);
    expect(result.err).toContain(`archon plugin remove ${BROKEN}`);
    expect(await snapshot(env.pluginsDir)).toEqual(before);
    expect((await run(env, 'install', BROKEN)).err).toContain(`${BROKEN} is installed, but`);
  });

  test('update repairs the broken plugin, replacing an executable nothing else can claim', async () => {
    const env = await environment();
    await installOther(env);
    await breakReceipt(env, ID);
    const target = join(env.pluginsDir, `archon-forge-github${hostExe}`);
    await writeFile(target, 'left by the broken install');
    const updated = await run(env, 'update', `${ID}@v2.0.0`);
    expect(updated.err).toBe('');
    expect(updated.code).toBe(0);
    expect(updated.out).toContain('Replaced the unreadable receipt');
    expect(await receiptOf(env)).toMatchObject({ tag: 'v2.0.0', commit: commits.get('v2.0.0') });
    expect(new Uint8Array(await readFile(target))).toEqual(new Uint8Array([2, 2]));
    expect((await run(env, 'list')).code).toBe(0);
  });

  test('update of a valid plugin works while another receipt is broken', async () => {
    const env = await environment();
    expect((await run(env, 'install', `${ID}@v2.0.0`)).code).toBe(0);
    await breakReceipt(env, BROKEN);
    const updated = await run(env, 'update', `${ID}@v2.0.0`);
    expect(updated.err).toBe('');
    expect(updated.code).toBe(0);
  });

  test('update of a broken plugin refuses an existing target another broken receipt could own', async () => {
    const env = await environment();
    await breakReceipt(env, ID);
    const other = await breakReceipt(env, BROKEN);
    const target = join(env.pluginsDir, `archon-forge-github${hostExe}`);
    await writeFile(target, 'owner unknown');
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'update', `${ID}@v2.0.0`);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`${target} exists and may belong to a plugin`);
    expect(result.err).toContain(`Invalid JSON in plugin receipt ${other}`);
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });
});

test('plugin references accept installable directories and reject unsafe segments', () => {
  expect(parsePluginRef('owner/repo/.archon/packs/review-kit@v1.0.0')).toMatchObject({
    id: 'owner/repo/.archon/packs/review-kit',
    tag: 'v1.0.0',
  });
  for (const target of [
    'owner/../x',
    'owner/repo/..',
    'owner/repo/path with spaces',
    'owner/repo/x;echo',
  ]) {
    expect(() => parsePluginRef(target)).toThrow('Invalid plugin');
  }
});
