import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { ArtifactWriteError, withContainerArtifactsRoot } from './artifact-writes';
import { writeNodeArtifact, writeNodeArtifactsListing } from './artifacts-index';
import { recordCheckoutSample, type CheckoutSample } from './checkout-observation';
import { formatPersistedNodeOutput } from './dag/node-output';
import { CHECKOUT_MANIFEST_VERSION, type CheckoutManifest } from './schemas/checkout-observation';
import { shellQuoteOrFile, writeSpillFile } from './dag/shell-quote';
import { MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS } from './deps';
import {
  clearManagedProviderCredentialFiles,
  resolveUserProviderEnvForWorkflow,
} from './run-credential-env';

let base: string;
let root: string;
let outside: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'artifact-writes-'));
  root = join(base, 'artifacts');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'sentinel'), 'untouched');
});
afterEach(async () => {
  await removeTempTree(base);
});

async function expectOutsideUntouched(): Promise<void> {
  expect(await readdir(outside)).toEqual(['sentinel']);
  expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('untouched');
}

const meta = {
  nodeId: 'probe',
  outputType: 'text',
  runId: 'run',
  producedAt: '2026-10-20T00:00:00Z',
};
// Above the inline threshold, so substitution and persistence spill to a file.
const large = 'x'.repeat(200_000);
const engineDir = (...parts: string[]) => join(RUN_ARTIFACTS_ENGINE_SUBDIR, ...parts);

function deliverCredential(...paths: string[]) {
  return resolveUserProviderEnvForWorkflow(
    {
      isPerUserProviderKeysEnabled: () => true,
      getUserProviderEnv: async () => ({
        env: {},
        protectedValues: [],
        files: paths.map(path => ({ path, contents: 'secret' })),
      }),
    },
    'user',
    root,
    [],
    new Set(['openai'])
  );
}

const dirtyManifest: CheckoutManifest = {
  version: CHECKOUT_MANIFEST_VERSION,
  objectFormat: 'sha1',
  commit: null,
  entries: [],
};
const dirtySample: CheckoutSample = {
  observation: { kind: 'git', sampledAt: '2026-10-20T00:00:00Z', commit: null, tree: null },
  worktree: {
    status: 'dirty',
    manifest: dirtyManifest,
    staged: 0,
    unstaged: 1,
    untracked: 0,
  },
};
const dirtyManifestPath = engineDir(
  'checkout',
  `${createHash('sha256').update(JSON.stringify(dirtyManifest)).digest('hex')}.json`
);

describe('in a container-mounted artifacts directory', () => {
  const contained = <T>(operation: () => T): T => withContainerArtifactsRoot(root, operation);

  // Every engine writer under the mount, each against a planted symlinked parent.
  const refusing: { parent: string; write: () => Promise<unknown> }[] = [
    { parent: 'nodes', write: () => writeNodeArtifact(root, meta, 'output') },
    { parent: engineDir('typed-artifacts'), write: () => writeNodeArtifactsListing(root, 'run') },
    {
      parent: engineDir('checkout'),
      write: () => recordCheckoutSample(dirtySample, { runId: 'run', artifactsDir: root }),
    },
    ...MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS.map(path => ({
      parent: dirname(path),
      write: () => deliverCredential(join(root, path)),
    })),
  ];

  test.each(refusing)('refuses a symlinked $parent/ and writes nothing through it', async c => {
    await mkdir(dirname(join(root, c.parent)), { recursive: true });
    await symlink(outside, join(root, c.parent));
    await expect(contained(c.write)).rejects.toThrow();
    await expectOutsideUntouched();
  });

  test('names the refused parent in the error', async () => {
    await symlink(outside, join(root, 'nodes'));
    const refusal = contained(() => writeNodeArtifact(root, meta, 'output'));
    await expect(refusal).rejects.toBeInstanceOf(ArtifactWriteError);
    await expect(refusal).rejects.toThrow(`'${join(root, 'nodes')}' is not a real directory`);
  });

  test('refuses a symlinked .archon/ above a writer directory', async () => {
    await symlink(outside, join(root, RUN_ARTIFACTS_ENGINE_SUBDIR));
    await expect(contained(() => writeNodeArtifactsListing(root, 'run'))).rejects.toThrow(
      ArtifactWriteError
    );
    await expectOutsideUntouched();
  });

  // Spill writers log and fall back to inline output rather than fail the node.
  test('a refused shell spill falls back to the inline value', async () => {
    await mkdir(join(root, RUN_ARTIFACTS_ENGINE_SUBDIR));
    await symlink(outside, join(root, engineDir('node-output-spills')));
    const quoted = contained(() => shellQuoteOrFile(large, 'probe', undefined, root));
    expect(quoted).toBe(`'${large}'`);
    await expectOutsideUntouched();
  });

  test('a refused persisted spill keeps the bounded preview without a spill path', async () => {
    await mkdir(join(root, engineDir('node-output-spills')), { recursive: true });
    await symlink(outside, join(root, engineDir('node-output-spills', 'persisted')));
    const persisted = contained(() => formatPersistedNodeOutput(large, root));
    expect(persisted.truncated).toBe(true);
    expect(persisted.spillPath).toBeUndefined();
    await expectOutsideUntouched();
  });

  test.each([
    'nodes/probe.md',
    'nodes/probe.meta.json',
    engineDir('node-output-spills', 'leaf.nodeoutput'),
    dirtyManifestPath,
    ...MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS,
  ])('replaces a leaf symlink at %s without touching its target', async leaf => {
    const path = join(root, leaf);
    await mkdir(dirname(path), { recursive: true });
    await symlink(join(outside, 'sentinel'), path);
    await contained(async () => {
      if (leaf.startsWith('nodes/')) await writeNodeArtifact(root, meta, 'output');
      else if (leaf.endsWith('auth.json')) await deliverCredential(path);
      else if (leaf === dirtyManifestPath) {
        await recordCheckoutSample(dirtySample, { runId: 'run', artifactsDir: root });
      } else expect(writeSpillFile(dirname(path), 'leaf.nodeoutput', large)).toBe(path);
    });
    const written = await lstat(path);
    expect(written.isFile()).toBe(true);
    if (leaf.endsWith('auth.json') && process.platform !== 'win32') {
      expect(written.mode & 0o777).toBe(0o600);
    }
    await expectOutsideUntouched();
  });

  test('credential cleanup removes a leaf link, not its target', async () => {
    const path = join(root, MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS[0]);
    await mkdir(dirname(path));
    await symlink(join(outside, 'sentinel'), path);
    await contained(() => clearManagedProviderCredentialFiles(root));
    await expect(lstat(path)).rejects.toThrow();
    await expectOutsideUntouched();
  });

  test('credential cleanup refuses a symlinked credential directory', async () => {
    const credentialDir = dirname(MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS[0]);
    await writeFile(join(outside, 'auth.json'), 'host secret');
    await symlink(outside, join(root, credentialDir));
    await expect(contained(() => clearManagedProviderCredentialFiles(root))).rejects.toThrow(
      ArtifactWriteError
    );
    expect(await readFile(join(outside, 'auth.json'), 'utf8')).toBe('host secret');
  });

  test('credential cleanup still removes later files after a refused path', async () => {
    const [refused, later] = MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS;
    await symlink(outside, join(root, dirname(refused)));
    await mkdir(dirname(join(root, later)));
    await writeFile(join(root, later), 'stale secret');
    await expect(contained(() => clearManagedProviderCredentialFiles(root))).rejects.toThrow(
      ArtifactWriteError
    );
    await expect(lstat(join(root, later))).rejects.toThrow();
    await expectOutsideUntouched();
  });

  test('a refused credential write cleans every file and reports the delivery failure', async () => {
    const [refused, delivered] = MANAGED_PROVIDER_CREDENTIAL_RELATIVE_PATHS;
    await symlink(outside, join(root, dirname(refused)));
    await expect(
      contained(() => deliverCredential(join(root, delivered), join(root, refused)))
    ).rejects.toThrow('Could not safely write provider credential files');
    await expect(lstat(join(root, delivered))).rejects.toThrow();
    await expectOutsideUntouched();
  });

  test('writes outside the scoped root are not checked', async () => {
    const elsewhere = join(base, 'scope');
    await mkdir(elsewhere);
    await symlink(outside, join(elsewhere, 'nodes'));
    await contained(() => writeNodeArtifact(elsewhere, meta, 'scope output'));
    expect(await readFile(join(outside, 'probe.md'), 'utf8')).toBe('scope output');
  });
});

test('host-only writes keep following links as before', async () => {
  await symlink(outside, join(root, 'nodes'));
  await withContainerArtifactsRoot(undefined, () => writeNodeArtifact(root, meta, 'host output'));
  expect(await readFile(join(outside, 'probe.md'), 'utf8')).toBe('host output');
});

test('concurrent host and container scopes keep their own write policy', async () => {
  await symlink(outside, join(root, 'nodes'));
  await Promise.all([
    withContainerArtifactsRoot(root, async () => {
      await Promise.resolve();
      await expect(writeNodeArtifact(root, meta, 'blocked')).rejects.toThrow(ArtifactWriteError);
    }),
    withContainerArtifactsRoot(undefined, async () => {
      await Promise.resolve();
      await writeNodeArtifact(root, meta, 'host output');
    }),
  ]);
  expect(await readFile(join(outside, 'probe.md'), 'utf8')).toBe('host output');
});
