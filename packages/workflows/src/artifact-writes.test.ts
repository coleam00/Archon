import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { withArtifactWriteRoot } from './artifact-writes';
import { writeNodeArtifact, writeNodeArtifactsListing } from './artifacts-index';
import { writeSpillFile, shellQuoteOrFile } from './dag/shell-quote';
import { formatPersistedNodeOutput } from './dag/node-output';
import {
  clearManagedProviderCredentialFiles,
  resolveUserProviderEnvForWorkflow,
} from './run-credential-env';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS } from './deps';

let base: string;
let root: string;
let outside: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'artifact-writers-'));
  root = join(base, 'artifacts');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'untouched');
});
afterEach(async () => {
  await removeTempTree(base);
});

const meta = {
  nodeId: 'probe',
  outputType: 'text',
  runId: 'run',
  producedAt: '2026-10-20T00:00:00Z',
};
const large = 'x'.repeat(40_000);
const spillDir = () => join(root, RUN_ARTIFACTS_ENGINE_SUBDIR, 'node-output-spills');
function deliver(path: string) {
  return resolveUserProviderEnvForWorkflow(
    {
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderEnv: async () => ({
        env: {},
        protectedValues: [],
        files: [{ path, contents: 'secret' }],
      }),
    },
    'user',
    root,
    [],
    new Set(['openai'])
  );
}

const operations = [
  { parent: 'nodes', write: () => writeNodeArtifact(root, meta, 'output') },
  {
    parent: join(RUN_ARTIFACTS_ENGINE_SUBDIR, 'typed-artifacts'),
    write: () => writeNodeArtifactsListing(root, 'run'),
  },
  {
    parent: join(RUN_ARTIFACTS_ENGINE_SUBDIR, 'node-output-spills'),
    write: () => shellQuoteOrFile(large, 'probe', undefined, root),
  },
  {
    parent: join(RUN_ARTIFACTS_ENGINE_SUBDIR, 'node-output-spills', 'persisted'),
    write: () => formatPersistedNodeOutput(large, root, 'probe'),
  },
  ...MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS.flatMap(path => [
    { parent: dirname(path), write: () => deliver(join(root, path)) },
    { parent: dirname(path), write: () => clearManagedProviderCredentialFiles(root) },
  ]),
];

test.each(operations)(
  'refuses planted parent $parent through the real writer',
  async ({ parent, write }) => {
    await mkdir(dirname(join(root, parent)), { recursive: true });
    await symlink(outside, join(root, parent));
    await expect(withArtifactWriteRoot(root, async () => write())).rejects.toThrow();
    expect(await readdir(outside)).toEqual(['sentinel']);
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  }
);

test.each([
  'nodes/probe.md',
  'nodes/probe.meta.json',
  ...MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS,
  `${RUN_ARTIFACTS_ENGINE_SUBDIR}/node-output-spills/persisted/probe.nodeoutput`,
  `${RUN_ARTIFACTS_ENGINE_SUBDIR}/node-output-spills/shell.nodeoutput`,
])('replaces leaf %s without truncating its target', async leaf => {
  const path = join(root, leaf);
  await mkdir(dirname(path), { recursive: true });
  await symlink(join(outside, 'sentinel'), path);
  await withArtifactWriteRoot(root, async () => {
    if (leaf.startsWith('nodes/')) await writeNodeArtifact(root, meta, 'output');
    else if (leaf.endsWith('auth.json')) await deliver(path);
    else if (leaf.includes('/persisted/')) formatPersistedNodeOutput(large, root, 'probe');
    else writeSpillFile(spillDir(), 'shell.nodeoutput', large);
  });
  expect((await lstat(path)).isFile()).toBe(true);
  expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
  if (leaf.endsWith('auth.json')) expect((await lstat(path)).mode & 0o777).toBe(0o600);
});

test('credential cleanup removes a leaf link without removing its target', async () => {
  const path = join(root, MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS[0]);
  await mkdir(dirname(path));
  await symlink(join(outside, 'sentinel'), path);
  await withArtifactWriteRoot(root, () => clearManagedProviderCredentialFiles(root));
  expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
});

test('host-only writes keep their existing symlink behavior', async () => {
  await symlink(outside, join(root, 'nodes'));
  await withArtifactWriteRoot(undefined, () => writeNodeArtifact(root, meta, 'host output'));
  expect(await readFile(join(outside, 'probe.md'), 'utf8')).toBe('host output');
});

test('concurrent host and protected scopes do not share a write policy', async () => {
  await symlink(outside, join(root, 'nodes'));
  await Promise.all([
    withArtifactWriteRoot(root, async () => {
      await Promise.resolve();
      await expect(writeNodeArtifact(root, meta, 'blocked')).rejects.toThrow('real directory');
    }),
    withArtifactWriteRoot(undefined, async () => {
      await Promise.resolve();
      await writeNodeArtifact(root, meta, 'host output');
    }),
  ]);
  expect(await readFile(join(outside, 'probe.md'), 'utf8')).toBe('host output');
});
