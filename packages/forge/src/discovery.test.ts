import { expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverPlugins } from './discovery';
import { dispatchForge } from './dispatch';

test('opportunistic discovery failures do not disable a healthy plugin or hide selected failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-discovery-'));
  try {
    const executable = join(root, `fixture${process.platform === 'win32' ? '.exe' : ''}`);
    const built = Bun.spawnSync(
      [
        process.execPath,
        'build',
        '--compile',
        join(import.meta.dir, 'fixtures/discovery-plugin.ts'),
        '--outfile',
        executable,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    if (built.exitCode !== 0) throw new Error(built.stderr.toString());
    const fixtureDir = async (name: string): Promise<string> => {
      const dir = join(root, name);
      await mkdir(dir);
      await link(
        executable,
        join(dir, `archon-forge-${name}${process.platform === 'win32' ? '.exe' : ''}`)
      );
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
      includeDefaultDir: false,
      timeoutMs: 500,
    });
    expect(hung.plugins).toHaveLength(0);
    expect(hung.unavailable.map(error => error.message)).toEqual([
      'plugin-dir:timeout: metadata handshake failed',
    ]);
    const config = { pluginDirs: dirs, scanPath: false };
    const found = await discoverPlugins({ config, includeDefaultDir: false });
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
        includeDefaultDir: false,
      })
    ).rejects.toThrow('metadata is not JSON');
    await expect(
      discoverPlugins({
        config: {
          plugins: [
            {
              plugin: 'invalid',
              command: join(
                dirs[1],
                `archon-forge-invalid${process.platform === 'win32' ? '.exe' : ''}`
              ),
            },
          ],
          scanPath: false,
        },
        includeDefaultDir: false,
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
        includeDefaultDir: false,
      });
      expect(linked.byHost.has('good.example')).toBe(true);
      expect(linked.unavailable).toHaveLength(1);
    }
  } finally {
    await removeTempTree(root);
  }
}, 60_000);
