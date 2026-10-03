import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFile, link, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';
import { runForgeReadConformance } from './outbound-conformance';

const exe = process.platform === 'win32' ? '.exe' : '';
let buildRoot: string;
let compiledFixture: string;

// One compile for the file. On windows-latest `bun build --compile` writes an ~86 MB
// executable to the OS disk and took 0.7-8 s of each test that ran it; installing the
// binary under a name is a hard link. The source is copied out of the repository first,
// so the build proves the fixture resolves no Archon code.
beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'forge-fixture-build-'));
  const entry = join(buildRoot, 'fixture.ts');
  await copyFile(join(import.meta.dir, 'fixtures', 'discovery-plugin.ts'), entry);
  compiledFixture = join(buildRoot, `fixture${exe}`);
  const built = Bun.spawnSync(
    [process.execPath, 'build', '--compile', entry, '--outfile', compiledFixture],
    { cwd: buildRoot, stdout: 'pipe', stderr: 'pipe' }
  );
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
});

afterAll(() => removeTempTree(buildRoot));

test('opportunistic discovery failures do not disable a healthy plugin or hide selected failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-discovery-'));
  try {
    const fixtureDir = async (name: string): Promise<string> => {
      const dir = join(root, name);
      await mkdir(dir);
      await link(compiledFixture, join(dir, `archon-forge-${name}${exe}`));
      return dir;
    };
    const dirs = [];
    for (const name of ['good', 'invalid', 'failed', 'incompatible', 'mismatch']) {
      dirs.push(await fixtureDir(name));
    }
    // One timeout budget covers every candidate in a discoverPlugins() call, so the
    // hung fixture gets its own short-budget call; the others keep the default
    // budget and cannot be misread as timed out on a loaded machine.
    const hung = await discoverPlugins({
      config: { pluginDirs: [await fixtureDir('timeout')], scanPath: false },
      timeoutMs: 500,
    });
    expect(hung.plugins).toHaveLength(0);
    expect(hung.unavailable.map(error => error.message)).toEqual([
      'plugin-dir:timeout: metadata handshake failed',
    ]);
    const config = { pluginDirs: dirs, scanPath: false };
    const found = await discoverPlugins({ config });
    expect(found.byHost.has('good.example')).toBe(true);
    expect(found.unavailable).toHaveLength(4);
    expect(found.plugins).toHaveLength(1);
    expect(found.plugins[0].source).toBe('plugin-dir:good');
    const selected = await dispatchForge(
      { operationId: 'valid', op: 'resolve', remote: 'https://good.example/a/b' },
      { discovery: found }
    );
    expect(selected.response.ok).toBe(true);
    const unknown = await dispatchForge(
      { operationId: 'unresolved', op: 'resolve', remote: 'https://unknown.example/a/b' },
      { discovery: found }
    );
    expect(unknown.response).toMatchObject({ ok: false, error: { kind: 'process_failed' } });
    await expect(
      discoverPlugins({
        config: { ...config, hosts: { 'selected.example': 'invalid' } },
      })
    ).rejects.toThrow('metadata is not JSON');
    await expect(
      discoverPlugins({
        config: {
          plugins: [
            {
              plugin: 'invalid',
              command: join(dirs[1], `archon-forge-invalid${exe}`),
            },
          ],
          scanPath: false,
        },
      })
    ).rejects.toThrow('metadata is not JSON');
    // The default directory plus a duplicate configured entry used to shift source labels.
    const home = join(root, 'home');
    await mkdir(join(home, 'plugins'), { recursive: true });
    const labeled = await discoverPlugins({
      config: { pluginDirs: [join(home, 'plugins'), dirs[0]], scanPath: false },
      env: { ...process.env, ARCHON_HOME: home },
    });
    expect(labeled.plugins[0].source).toBe('plugin-dir:good');
    if (process.platform !== 'win32') {
      const broken = join(root, 'broken');
      await mkdir(broken);
      await symlink(join(root, 'missing'), join(broken, 'archon-forge-missing'));
      const linked = await discoverPlugins({
        config: { pluginDirs: [dirs[0], broken], scanPath: false },
      });
      expect(linked.byHost.has('good.example')).toBe(true);
      expect(linked.unavailable).toHaveLength(1);
    }
  } finally {
    await removeTempTree(root);
  }
}, 60_000);

test('discovers and runs an independently installed executable outside the source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-external-'));
  try {
    const plugins = join(root, 'plugins');
    await mkdir(plugins);
    const executable = join(plugins, `archon-forge-external-fixture${exe}`);
    await link(compiledFixture, executable);
    const env = {
      ...process.env,
      EXTERNAL_FORGE_TOKEN: 'fixture-credential',
      UNRELATED_SECRET: 'must-not-be-inherited',
    };
    const discovery = await discoverPlugins({
      config: { pluginDirs: [plugins], scanPath: false },
      env,
    });
    expect(discovery.plugins.map(plugin => plugin.command)).toEqual([executable]);
    const request = {
      operationId: 'external-observation',
      op: 'checks.state' as const,
      ref: { repo: { host: 'fixture.invalid', path: 'group/project' }, number: 42 },
    };
    const missing = await dispatchForge(request, { discovery, env: {} });
    expect(missing.response).toMatchObject({ ok: false, error: { kind: 'no_credential' } });
    const failures = await runForgeReadConformance(
      async input => (await dispatchForge(input, { discovery, env })).response,
      [
        {
          name: 'externally installed producer',
          request,
          expected: {
            revision: 'fixture-revision',
            state: 'green',
            units: [{ kind: 'commit_status', id: 'external-1' }],
          },
        },
      ]
    );
    expect(failures).toEqual([]);
  } finally {
    await removeTempTree(root);
  }
});
