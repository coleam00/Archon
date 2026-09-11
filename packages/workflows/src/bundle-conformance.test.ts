import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import * as defaults from './defaults/bundled-defaults';
import { captureWorkflowSource } from './workflow-source';
import { readBundleIndex } from './defaults/bundle-inventory';

const root = await mkdtemp(join(tmpdir(), 'archon-bundle-conformance-'));
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = join(root, 'home');
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(root);
});

async function files(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await files(root, relative));
    else result[relative] = await readFile(join(root, relative), 'utf8');
  }
  return result;
}

test('source and binary captures contain exactly the same bundled files and bytes', async () => {
  const project = join(root, 'project');
  await mkdir(project);
  const source = await captureWorkflowSource({
    sourceRoot: project,
    captureRoot: join(root, 'source'),
  });
  const binaryMode = spyOn(defaults, 'isBinaryBuild').mockReturnValue(true);
  try {
    const binary = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(root, 'binary'),
    });
    const sourceFiles = await files(join(source.anchor.root, 'bundled'));
    const binaryFiles = await files(join(binary.anchor.root, 'bundled'));
    expect(Object.keys(sourceFiles).sort()).toEqual(Object.keys(binaryFiles).sort());
    expect(sourceFiles).toEqual(binaryFiles);
    const workflowPaths = Object.keys(sourceFiles).filter(path => path.startsWith('workflows/'));
    expect([...new Set(workflowPaths.map(path => path.split('/')[1]))].sort()).toEqual(
      (await readBundleIndex()).sort()
    );
    expect(workflowPaths.some(path => path.includes('/fixtures/'))).toBe(false);
  } finally {
    binaryMode.mockRestore();
  }
});
