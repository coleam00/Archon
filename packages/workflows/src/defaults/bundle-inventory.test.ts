import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { collectBundleSources, readBundleContent, readBundleIndex } from './bundle-inventory';

const track = trackTempRoots();

test.each(['workflows/defaults/__proto__.yaml', 'commands/defaults/Uppercase.md'])(
  'retains the strict legacy default filename contract for %s',
  async path => {
    const root = track(await mkdtemp(join(tmpdir(), 'archon-bundle-name-')));
    await mkdir(join(root, 'workflows/defaults'), { recursive: true });
    await mkdir(join(root, 'commands/defaults'), { recursive: true });
    await writeFile(join(root, path), 'invalid default');
    await expect(
      collectBundleSources(join(root, 'workflows'), join(root, 'commands'), ['defaults'])
    ).rejects.toThrow('Names must be kebab-case');
  }
);

test('dereferences a linked workflow directory instead of silently omitting its runtime files', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'archon-bundle-link-')));
  const target = join(root, 'authored-flow');
  const pack = join(root, 'workflows', 'selected');
  await mkdir(join(target, 'scripts'), { recursive: true });
  await mkdir(pack, { recursive: true });
  await writeFile(join(target, 'main.yaml'), 'name: main\n');
  await writeFile(join(target, 'scripts/run.ts'), 'console.log(1);\n');
  // A directory junction exercises Windows link traversal without administrator rights.
  await symlink(target, join(pack, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const selected = await collectBundleSources(join(root, 'workflows'), join(root, 'commands'), [
    'selected',
  ]);
  expect(selected.map(file => file.relativePath)).toEqual([
    'workflows/selected/linked/main.yaml',
    'workflows/selected/linked/scripts/run.ts',
  ]);
});

test('the index selects exact runtime files, preserving authored paths and excluding fixtures and unindexed packs', async () => {
  const root = track(await mkdtemp(join(tmpdir(), 'archon-bundle-index-')));
  const authored: Record<string, string> = {
    'workflows/selected/flow/main.yml': 'name: main\r\n',
    'workflows/selected/flow/commands/check.md': 'Check it.\r\n',
    'workflows/selected/flow/scripts/run.ts': 'console.log(1);\r\n',
    'workflows/selected/flow/scripts/helpers/tool.py': 'print(1)\n',
    'workflows/selected/.shared/nested/helper.js': 'export const value = 1;\n',
    'workflows/selected/.shared/__init__.py': '',
    'workflows/selected/flow/fixtures/clean.stubs.yaml': 'fixture: true\n',
    'workflows/selected/flow/README.md': 'documentation',
    'workflows/selected/flow/scripts/helpers/deeper/ignored.ts': 'ignored',
    'workflows/selected/.shared/data.json': '{}',
    'workflows/selected/.shared/__pycache__/cached.pyc': 'bytecode',
    'workflows/unselected/broken/first.yaml': 'not even a valid pack',
    'workflows/unselected/broken/second.yaml': 'not inspected',
  };
  for (const [path, content] of Object.entries(authored)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const indexPath = join(root, 'index.json');
  await writeFile(indexPath, JSON.stringify({ packs: ['selected'] }));
  const selected = await collectBundleSources(
    join(root, 'workflows'),
    join(root, 'commands'),
    await readBundleIndex(indexPath)
  );
  expect(selected.map(file => file.relativePath).sort()).toEqual([
    'workflows/selected/.shared/__init__.py',
    'workflows/selected/.shared/nested/helper.js',
    'workflows/selected/flow/commands/check.md',
    'workflows/selected/flow/main.yml',
    'workflows/selected/flow/scripts/helpers/tool.py',
    'workflows/selected/flow/scripts/run.ts',
  ]);
  for (const file of selected)
    expect(await readBundleContent(file)).toBe(authored[file.relativePath].replace(/\r\n/g, '\n'));
  await expect(
    collectBundleSources(join(root, 'workflows'), join(root, 'commands'), ['missing'])
  ).rejects.toThrow('Indexed bundle pack "missing" directory not found');
  await writeFile(indexPath, JSON.stringify({ packs: ['selected', 'selected'] }));
  await expect(readBundleIndex(indexPath)).rejects.toThrow('Duplicate bundle pack');
  await writeFile(indexPath, JSON.stringify({ packs: ['../outside'] }));
  await expect(readBundleIndex(indexPath)).rejects.toThrow('Invalid bundle pack name');
});
