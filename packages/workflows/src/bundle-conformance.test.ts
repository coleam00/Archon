// @archon-test-isolated
import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import * as inventory from './defaults/bundle-inventory';
import { writeFakeBundle } from './test-fake-bundle';

const root = await mkdtemp(join(tmpdir(), 'archon-bundle-conformance-'));
const originalHome = process.env.ARCHON_HOME;
process.env.ARCHON_HOME = join(root, 'home');
afterAll(async () => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
  await removeTempTree(root);
});

// One fake pack with every kind of bundled file, plus a fixture that must stay out. The
// source capture reads this tree; the binary capture reads the records built from it.
const bundleRoot = join(root, 'bundle');
const records = await writeFakeBundle(
  bundleRoot,
  {
    'fake/.shared/message.ts': "export const message = 'shared';\n",
    'fake/.shared/policy.md': '# Policy\n',
    'fake/flow/fake-flow.yaml':
      'name: fake-flow\ndescription: Flow fixture.\nnodes:\n  - id: work\n    command: work\n',
    'fake/flow/commands/work.md': 'Do the work the flow describes.\n',
    'fake/flow/scripts/helper.ts': "import { message } from '../../.shared/message.ts';\n",
    'fake/flow/fixtures/clean.stubs.yaml': 'fixture:\n  expect: completed\n',
  },
  ['fake']
);
// Loaded before the index spy: importing it reads the real tree once, by design.
const actualDefaults = await import('./defaults/bundled-defaults');
spyOn(inventory, 'readBundleIndex').mockResolvedValue(['fake']);
const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({ ...realPaths, getBundledWorkflowsPath: () => bundleRoot }));
let binary = false;
mock.module('./defaults/bundled-defaults', () => ({
  ...actualDefaults,
  ...records,
  isBinaryBuild: () => binary,
}));
const { captureWorkflowSource } = await import('./workflow-source');

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
  binary = true;
  try {
    const binaryCapture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(root, 'binary'),
    });
    const sourceFiles = await files(join(source.anchor.root, 'bundled'));
    const binaryFiles = await files(join(binaryCapture.anchor.root, 'bundled'));
    expect(sourceFiles).toEqual(binaryFiles);
    const paths = Object.keys(sourceFiles);
    expect(paths.some(path => path.endsWith('/fake-flow.yaml'))).toBe(true);
    expect(paths.some(path => path.endsWith('/commands/work.md'))).toBe(true);
    expect(paths.some(path => path.endsWith('/scripts/helper.ts'))).toBe(true);
    expect(paths.some(path => path.endsWith('/.shared/policy.md'))).toBe(true);
    expect(paths.some(path => path.includes('/fixtures/'))).toBe(false);
  } finally {
    binary = false;
  }
});
