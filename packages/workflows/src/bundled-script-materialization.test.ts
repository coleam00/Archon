import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { BundledScriptPack } from './defaults/bundled-script-pack';
import type { ScriptDefinition } from './script-discovery';

const names = {
  bun: '__archon_pack__bundled:example:first::hello',
  uv: '__archon_pack__bundled:example:second::hello-python',
};
const files = {
  '.shared/nested/message.ts': "export const message = 'shared-ok';\n",
  '.shared/python_helper/__init__.py': '',
  '.shared/python_helper/message.py': "message = 'shared-ok'\n",
  'first/scripts/group/hello.ts':
    "import { message } from '../../../.shared/nested/message.ts';\nconsole.log(message);\n",
  'second/scripts/group/hello-python.py':
    "from pathlib import Path\nimport sys\nsys.path.insert(0, str(Path(__file__).resolve().parents[3] / '.shared'))\nfrom python_helper.message import message\nprint(message)\n",
};
const fixture: BundledScriptPack = {
  files,
  scripts: {
    [names.bun]: { path: 'first/scripts/group/hello.ts', runtime: 'bun' },
    [names.uv]: { path: 'second/scripts/group/hello-python.py', runtime: 'uv' },
  },
};
const packs: Record<string, BundledScriptPack> = { example: fixture };
let binary = true;
const actual = await import('./defaults/bundled-defaults');
mock.module('./defaults/bundled-defaults', () => ({
  ...actual,
  BUNDLED_SCRIPT_PACKS: packs,
  isBinaryBuild: () => binary,
}));
const { discoverScriptsForCwd } = await import('./script-discovery');
const { captureWorkflowSource, capturedSourceRoots, liveSourceRoots, loadWorkflowSource } =
  await import('./workflow-source');

async function treeContents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await readdir(root, { recursive: true })) {
    if ((await stat(join(root, path))).isFile()) {
      result[path.replaceAll('\\', '/')] = await readFile(join(root, path), 'utf8');
    }
  }
  return result;
}

async function execute(script: ScriptDefinition, target: string): Promise<string> {
  const argv =
    script.runtime === 'bun'
      ? ['bun', '--no-env-file', 'run', script.path]
      : ['uv', 'run', script.path];
  const child = Bun.spawn(argv, {
    cwd: target,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // The exit code and the exact stdout every caller asserts already pin the behavior
  // under test. `uv` owns its own stderr and reports interpreter provisioning there when
  // the machine has no suitable Python, so requiring it to be empty would tie this test
  // to a vendor's diagnostic channel rather than to a result. Bun's stderr stays strict:
  // that invocation is this repository's own.
  expect(exitCode).toBe(0);
  if (script.runtime === 'bun') expect(stderr).toBe('');
  return stdout.trim();
}

describe('pack shared modules across source and binary distributions (#3251)', () => {
  let root: string;
  let target: string;
  let originalArchonHome: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-bundled-script-'));
    target = join(root, 'empty-target');
    await mkdir(target);
    originalArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
    packs.example = fixture;
    binary = true;
  });
  afterEach(async () => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    await removeTempTree(root);
  });

  it('runs identical Bun and Python sources from project, global, bundled, cache and frozen roots', async () => {
    const source = join(root, 'authoring');
    const roots = { ...liveSourceRoots(source), bundledWorkflows: join(root, 'bundled-source') };
    for (const workflows of [
      join(source, '.archon', 'workflows'),
      roots.globalWorkflows,
      roots.bundledWorkflows,
    ]) {
      for (const [path, content] of Object.entries(files)) {
        const destination = join(workflows, 'example', path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
    }
    const before = await treeContents(root);
    binary = false;
    const sourceScripts = await discoverScriptsForCwd(target, roots);
    expect(sourceScripts.size).toBe(6);
    for (const script of sourceScripts.values())
      expect(await execute(script, target)).toBe('shared-ok');
    expect(await treeContents(root)).toEqual(before);

    binary = true;
    const live = await discoverScriptsForCwd(target);
    for (const [name, entry] of Object.entries(fixture.scripts)) {
      const script = live.get(name)!;
      expect(script.path).toContain('/cache/workflow-scripts/example/');
      expect(script.path.endsWith(entry.path)).toBe(true);
      expect(await execute(script, target)).toBe('shared-ok');
    }
    const capture = await captureWorkflowSource({
      sourceRoot: source,
      captureRoot: join(root, 'capture'),
    });
    const frozenBefore = await treeContents(capture.anchor.root);
    const frozen = await discoverScriptsForCwd(target, capturedSourceRoots(capture.anchor));
    expect(frozen.size).toBe(6);
    for (const script of frozen.values()) {
      expect(script.path.startsWith(capture.anchor.root.replaceAll('\\', '/'))).toBe(true);
      expect(await execute(script, target)).toBe('shared-ok');
    }
    expect(await treeContents(capture.anchor.root)).toEqual(frozenBefore);
    expect(
      (await loadWorkflowSource(capture.anchor.root, capture.manifest.digest)).manifest.digest
    ).toBe(capture.manifest.digest);
    expect(await readdir(target)).toEqual([]);
  });

  it('reuses unchanged files and invalidates the whole pack for a helper-only edit', async () => {
    const first = await discoverScriptsForCwd(target);
    const oldScript = first.get(names.bun)!;
    const oldPython = first.get(names.uv)!;
    const timestamp = new Date('2000-01-01T00:00:00Z');
    await utimes(oldScript.path, timestamp, timestamp);
    const second = await discoverScriptsForCwd(target);
    expect(second.get(names.bun)?.path).toBe(oldScript.path);
    expect((await stat(oldScript.path)).mtimeMs).toBe(timestamp.getTime());
    packs.example = {
      ...fixture,
      files: { ...files, '.shared/nested/message.ts': "export const message = 'updated';\n" },
    };
    const changed = await discoverScriptsForCwd(target);
    expect(changed.get(names.bun)?.path).not.toBe(oldScript.path);
    expect(changed.get(names.uv)?.path).not.toBe(oldPython.path);
    expect(await execute(changed.get(names.bun)!, target)).toBe('updated');
    expect(await execute(oldScript, target)).toBe('shared-ok');
  });

  it('accepts Windows publication races but preserves permission failures without a published unit', async () => {
    const originalRename = fs.rename;
    const failure = Object.assign(new Error('rename denied'), { code: 'EPERM' });
    const rename = spyOn(fs, 'rename');
    try {
      rename.mockImplementationOnce(async (from, to) => {
        await originalRename(from, to);
        throw failure;
      });
      const scripts = await discoverScriptsForCwd(target);
      expect(await execute(scripts.get(names.bun)!, target)).toBe('shared-ok');
      packs.example = { ...fixture, files: { ...files, '.shared/other.ts': 'export {};\n' } };
      rename.mockRejectedValueOnce(failure);
      await expect(discoverScriptsForCwd(target)).rejects.toBe(failure);
    } finally {
      rename.mockRestore();
    }
  });

  it('concurrent discovery returns complete pack trees with no module entry points', async () => {
    const discoveries = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const scripts = await discoverScriptsForCwd(target);
        expect([...scripts.keys()].sort()).toEqual(Object.values(names).sort());
        const unitRoot = join(dirname(scripts.get(names.bun)!.path), '../../..');
        expect(await treeContents(unitRoot)).toEqual(files);
        return scripts.get(names.bun)!.path;
      })
    );
    expect(new Set(discoveries).size).toBe(1);
    expect(await readdir(join(root, 'home', 'cache', 'workflow-scripts', 'example'))).toHaveLength(
      1
    );
  });
});
