import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPlugins } from '@archon/forge/discovery';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';
import { pluginCommand, stagingName, type PluginEnvironment } from './plugin';

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
const latestTag = 'v1.0.0';

const manifest = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: 'forge',
  name: 'forge-github',
  description: 'fixture',
  executable: 'archon-forge-github',
  ...extra,
});

// On a Windows host this asset is also the host's, so it must stay the working binary.
const windowsBinary = (): Uint8Array =>
  hostAsset === 'archon-forge-github-windows-x64.exe' ? pluginBinary : new Uint8Array([7]);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const checksumsFor = (assets: Record<string, Uint8Array>): string =>
  Object.entries(assets)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
    .join('');

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'plugin-install-fixture-'));
  // A real executable that answers forge discovery's metadata handshake as `github`.
  const binaryPath = join(fixtureRoot, `archon-forge-github${hostExe}`);
  const built = Bun.spawnSync(
    [
      process.execPath,
      'build',
      '--compile',
      join(import.meta.dir, '../../../forge/src/fixtures/discovery-plugin.ts'),
      '--outfile',
      binaryPath,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  pluginBinary = new Uint8Array(await readFile(binaryPath));

  const repo = join(fixtureRoot, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q');
  for (const [tag, annotated] of [
    ['v1.0.0', true],
    ['v2.0.0', false],
    ['v3.0.0', false],
    ['v4.0.0', false],
  ] as const) {
    await git(repo, 'commit', '-q', '--allow-empty', '-m', tag);
    await git(repo, 'tag', ...(annotated ? ['-a', '-m', tag] : []), tag);
    commits.set(tag, await git(repo, 'rev-parse', 'HEAD'));
  }
  await git(repo, 'update-server-info');

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
      const gitFile = /^\/owner\/repo\.git\/(.+)$/.exec(path);
      if (gitFile) {
        const file = Bun.file(join(repo, '.git', gitFile[1]));
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      }
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
  releases.set('v1.0.0', {
    assets: {
      [hostAsset]: pluginBinary,
      'archon-forge-github-windows-x64.exe': windowsBinary(),
    },
  });
  releases.set('v2.0.0', { assets: { [hostAsset]: new Uint8Array([2, 2]) } });
  releases.set('v3.0.0', { assets: { [hostAsset]: new Uint8Array([3]) } });
  // The asset was replaced after checksums.txt was generated.
  releases.set('v4.0.0', {
    assets: { [hostAsset]: new Uint8Array([4, 4]) },
    checksums: checksumsFor({ [hostAsset]: new Uint8Array([4]) }),
  });
});

afterAll(async () => {
  await server.stop(true);
  await removeTempTree(fixtureRoot);
});

async function environment(overrides: Partial<PluginEnvironment> = {}): Promise<PluginEnvironment> {
  const home = tempRoot(await mkdtemp(join(tmpdir(), 'plugin-install-home-')));
  return {
    pluginsDir: join(home, 'plugins'),
    archonVersion: '0.11.0',
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
  JSON.parse(
    await readFile(join(env.pluginsDir, 'installed', ...ID.split('/'), 'receipt.json'), 'utf8')
  ) as Record<string, unknown>;

describe('archon plugin', () => {
  test('installs the latest release where forge discovery finds it, then updates, lists and removes it', async () => {
    const env = await environment();
    const installed = await run(env, 'install', ID);
    expect(installed.err).toBe('');
    expect(installed.code).toBe(0);
    expect(installed.out).toContain(`commit ${commits.get('v1.0.0')}`);

    const receipt = await receiptOf(env);
    expect(receipt).toMatchObject({ id: ID, tag: 'v1.0.0', commit: commits.get('v1.0.0') });
    const discovery = await discoverPlugins({
      config: { scanPath: false },
      env: { ARCHON_HOME: join(env.pluginsDir, '..') },
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
  });

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
    expect((await run(env, 'install', ID)).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const result = await run(env, 'install', 'owner/repo/plugins/copy');
    expect(result.err).toContain(`belongs to ${ID}`);
    expect(await snapshot(env.pluginsDir)).toEqual(before);
  });

  test('names the executable with .exe on Windows', async () => {
    const env = await environment({ platform: 'win32', arch: 'x64' });
    expect((await run(env, 'install', `${ID}@v1.0.0`)).code).toBe(0);
    expect(Object.keys(await snapshot(env.pluginsDir))[0]).toBe('archon-forge-github.exe');
    expect(await receiptOf(env)).toMatchObject({
      files: [{ path: 'archon-forge-github.exe', sha256: sha256(windowsBinary()) }],
    });
  });

  test('forge discovery does not see a binary under its staging name', async () => {
    const env = await environment();
    await mkdir(env.pluginsDir, { recursive: true });
    const staged = join(env.pluginsDir, stagingName(`archon-forge-github${hostExe}`));
    await writeFile(staged, pluginBinary, { mode: 0o755 });
    const stderr = spyOn(process.stderr, 'write');
    try {
      const discovery = await discoverPlugins({
        config: { scanPath: false },
        env: { ARCHON_HOME: join(env.pluginsDir, '..') },
      });
      expect(discovery.plugins).toEqual([]);
      expect(discovery.unavailable).toEqual([]);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
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
