// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { liveSourceRoots, DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source';
import { formatPackagedResourceReference } from './packaged-workflow';
import { discoverScriptsForCwd, discoverScripts } from './script-discovery';

import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';

const track = trackTempRoots();
for (const grouped of [false, true]) {
  test(`selected scripts survive unrelated dangling links (grouped=${grouped})`, async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'scripts-links-')));
    const scripts = grouped ? join(root, 'group') : root;
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'good.ts'), 'console.log("ok")');
    await symlink(join(root, 'absent'), join(scripts, 'unrelated.ts'));
    expect((await discoverScripts(root, new Set(['good']))).has('good')).toBe(true);
    expect((await discoverScripts(root)).has('good')).toBe(true);
  });
}

test('a linked group is traversed whatever its name', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'scripts-links-')));
  const target = join(root, 'target');
  const scripts = join(root, 'scripts');
  await mkdir(target, { recursive: true });
  await mkdir(scripts);
  await writeFile(join(target, 'good.ts'), 'console.log("ok")');
  await symlink(target, join(scripts, 'group.v2'));
  expect((await discoverScripts(scripts, new Set(['good']))).get('good')?.path).toBe(
    join(scripts, 'group.v2', 'good.ts').replaceAll('\\', '/')
  );
});

for (const grouped of [false, true]) {
  test(`selected scripts survive an unrelated looping link (grouped=${grouped})`, async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'scripts-links-')));
    const scripts = grouped ? join(root, 'group') : root;
    await mkdir(scripts, { recursive: true });
    await writeFile(join(scripts, 'good.ts'), 'console.log("ok")');
    await symlink(join(scripts, 'loop'), join(scripts, 'loop'));
    expect((await discoverScripts(root, new Set(['good']))).has('good')).toBe(true);
    expect((await discoverScripts(root)).has('good')).toBe(true);
  });
}

for (const source of ['project', 'global', 'installed'] as const) {
  test(`selected live ${source} packaged script ignores a dangling neighbor`, async () => {
    const root = track(await mkdtemp(join(tmpdir(), 'packaged-links-')));
    const pack = source === 'installed' ? 'acme.pack' : 'pack';
    const packRoot =
      source === 'project'
        ? join(root, 'project', '.archon', 'workflows', pack)
        : source === 'installed'
          ? packTreePath(join(root, 'plugins'), 'acme/pack', 'a'.repeat(40))
          : join(root, source, 'workflows', pack);
    const dir = join(packRoot, 'deliver', 'scripts');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'good.ts'), 'console.log("ok")');
    await writeFile(
      join(packRoot, 'deliver/workflow.yaml'),
      'name: deliver\ndescription: Fixture\nnodes:\n  - id: run\n    bash: echo ok\n'
    );
    await symlink(join(root, 'absent'), join(dir, 'unrelated.ts'));
    if (source === 'installed') {
      const manifest = {
        schemaVersion: 1,
        kind: 'workflow-pack',
        name: 'pack',
        description: 'Test',
        entrypoints: { deliver: 'deliver/workflow.yaml' },
      };
      await writeFile(join(packRoot, 'archon-plugin.json'), JSON.stringify(manifest));
      const receipt = receiptPath(join(root, 'plugins'), 'acme/pack');
      await mkdir(dirname(receipt), { recursive: true });
      await writeFile(
        receipt,
        JSON.stringify({
          schemaVersion: 1,
          id: 'acme/pack',
          commit: 'a'.repeat(40),
          manifest,
          installedAt: new Date(0).toISOString(),
        })
      );
    }
    const roots = {
      ...liveSourceRoots(join(root, 'project'), DEFAULT_WORKFLOW_SOURCE_CONFIG, {
        kind: 'receipts',
        pluginsDir: join(root, 'plugins'),
      }),
      globalWorkflows: join(root, 'global/workflows'),
      globalScripts: join(root, 'global/scripts'),
      bundledWorkflows: join(root, 'bundled/workflows'),
    };
    const name = formatPackagedResourceReference({ source, pack, workflow: 'deliver' }, 'good');
    const scripts = await discoverScriptsForCwd(root, roots, new Set([name]));
    expect(scripts.get(name)?.path).toBe(join(dir, 'good.ts').replaceAll('\\', '/'));
  });
}
