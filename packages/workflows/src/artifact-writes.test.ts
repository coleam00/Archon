import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  ArtifactWriteError,
  readArtifactFile,
  withContainerArtifactsRoot,
} from './artifact-writes';
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

  test('replaces metadata links without reading their foreign owner', async () => {
    const target = join(outside, 'sentinel');
    const foreignOwner = JSON.stringify({ nodeId: 'another-node' });
    await writeFile(target, foreignOwner);
    await mkdir(join(root, 'nodes'));
    const path = join(root, 'nodes', 'probe.meta.json');
    await symlink(target, path);

    await contained(() => writeNodeArtifact(root, meta, 'output'));

    expect((await lstat(path)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(meta);
    expect(await readFile(target, 'utf8')).toBe(foreignOwner);
  });

  test('regular metadata preserves collisions and same-owner rewrites', async () => {
    await contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a.b' }, 'first'));
    await expect(
      contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a_b' }, 'collision'))
    ).rejects.toThrow('collision');
    expect(await readFile(join(root, 'nodes', 'a_b.md'), 'utf8')).toBe('first');
    await contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a.b' }, 'second'));
    expect(await readFile(join(root, 'nodes', 'a_b.md'), 'utf8')).toBe('second');
  });

  test('skips planted metadata links even when open ignores no-follow flags', async () => {
    await mkdir(join(root, 'nodes'));
    const path = join(root, 'nodes', 'probe.meta.json');
    const target = join(outside, 'sentinel');
    await writeFile(target, JSON.stringify({ nodeId: 'foreign' }));
    await symlink(target, path);
    const realOpen = fsPromises.open;
    const intercepted = spyOn(fsPromises, 'open').mockImplementation((file, _flags, mode) =>
      realOpen(file, constants.O_RDONLY, mode)
    );
    try {
      expect(await contained(() => readArtifactFile(path))).toBeUndefined();
      expect(intercepted).not.toHaveBeenCalled();
    } finally {
      intercepted.mockRestore();
    }
  });

  test.each(['symlink', 'regular file'])(
    'refuses a %s substituted before open when no-follow flags are ignored',
    async kind => {
      await mkdir(join(root, 'nodes'));
      const path = join(root, 'nodes', 'probe.meta.json');
      await writeFile(path, JSON.stringify({ nodeId: 'probe' }));
      const target = join(outside, 'sentinel');
      await writeFile(target, JSON.stringify({ nodeId: 'foreign' }));
      const original = join(root, 'original');
      const realOpen = fsPromises.open;
      let read = false;
      const intercepted = spyOn(fsPromises, 'open').mockImplementation(
        async (file, _flags, mode) => {
          await rename(path, original);
          if (kind === 'symlink') await symlink(target, path);
          else await writeFile(path, JSON.stringify({ nodeId: 'foreign' }));
          const handle = await realOpen(file, constants.O_RDONLY, mode);
          spyOn(handle, 'readFile').mockImplementation(() => {
            read = true;
            throw new Error('foreign metadata must not be read');
          });
          return handle;
        }
      );
      try {
        await expect(contained(() => readArtifactFile(path))).rejects.toThrow(ArtifactWriteError);
        expect(read).toBe(false);
      } finally {
        intercepted.mockRestore();
      }
    }
  );

  test.each(['dev', 'ino'] as const)(
    'compares exact %s values beyond the safe integer range before reading metadata',
    async field => {
      const path = join(root, 'probe.meta.json');
      const metadata = JSON.stringify({ nodeId: 'probe' });
      await writeFile(path, metadata);
      const identity = 2n ** 53n;
      expect(Number(identity)).toBe(Number(identity + 1n));
      let openedIdentity = identity;
      const realLstat = fs.lstatSync;
      const statFs: {
        lstatSync: (...args: Parameters<typeof realLstat>) => ReturnType<typeof realLstat>;
      } = fs;
      const inspected = spyOn(statFs, 'lstatSync').mockImplementation((...args) => {
        const entry = realLstat(...args);
        if (entry !== undefined && args[0] === path) {
          Object.defineProperty(entry, field, {
            value: typeof entry[field] === 'bigint' ? identity : Number(identity),
          });
        }
        return entry;
      });
      const realOpen = fsPromises.open;
      let assertUnreadAndClosed: () => void = () => {
        throw new Error('metadata was not opened');
      };
      const intercepted = spyOn(fsPromises, 'open').mockImplementation(
        async (file, _flags, mode) => {
          const handle = await realOpen(file, constants.O_RDONLY, mode);
          const realStat = handle.stat.bind(handle);
          const statHandle: {
            stat: (...args: Parameters<typeof realStat>) => ReturnType<typeof realStat>;
          } = handle;
          spyOn(statHandle, 'stat').mockImplementation(async (...args) => {
            const entry = await realStat(...args);
            Object.defineProperty(entry, field, {
              value: typeof entry[field] === 'bigint' ? openedIdentity : Number(openedIdentity),
            });
            return entry;
          });
          const read = spyOn(handle, 'readFile');
          const closed = spyOn(handle, 'close');
          assertUnreadAndClosed = () => {
            expect(read).not.toHaveBeenCalled();
            expect(closed).toHaveBeenCalledTimes(1);
          };
          return handle;
        }
      );
      try {
        expect(await contained(() => readArtifactFile(path))).toBe(metadata);
        openedIdentity = identity + 1n;
        await expect(contained(() => readArtifactFile(path))).rejects.toThrow(
          'changed during open'
        );
        assertUnreadAndClosed();
      } finally {
        intercepted.mockRestore();
        inspected.mockRestore();
      }
    }
  );

  test.skipIf(process.platform === 'win32').each(['symlink', 'FIFO'])(
    'reads the opened regular metadata when its pathname is replaced by a %s',
    async kind => {
      await mkdir(join(root, 'nodes'));
      const path = join(root, 'nodes', 'probe.meta.json');
      const original = JSON.stringify({ nodeId: 'probe' });
      await writeFile(path, original);
      const replacement = join(root, 'replacement');
      if (kind === 'symlink') {
        await writeFile(join(outside, 'sentinel'), JSON.stringify({ nodeId: 'foreign' }));
        await symlink(join(outside, 'sentinel'), replacement);
      } else {
        expect(Bun.spawnSync(['mkfifo', replacement]).exitCode).toBe(0);
      }
      const realOpen = fsPromises.open;
      let swapped = false;
      const intercepted = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[0] === path) {
          await rename(replacement, path);
          swapped = true;
        }
        return handle;
      });
      try {
        expect(await contained(() => readArtifactFile(path))).toBe(original);
        expect(swapped).toBe(true);
        const entry = await lstat(path);
        expect(kind === 'symlink' ? entry.isSymbolicLink() : entry.isFIFO()).toBe(true);
      } finally {
        intercepted.mockRestore();
      }
    }
  );

  test('metadata handle read errors preserve the first producer and close the handle', async () => {
    await contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a.b' }, 'first'));
    const path = join(root, 'nodes', 'a_b.meta.json');
    const originalMetadata = await readFile(path, 'utf8');
    const failure = Object.assign(new Error('metadata read failed'), { code: 'EIO' });
    const realOpen = fsPromises.open;
    let assertReadAndClosed: () => void = () => {
      throw new Error('metadata was not opened');
    };
    const intercepted = spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === path) {
        const read = spyOn(handle, 'readFile').mockRejectedValue(failure);
        const closed = spyOn(handle, 'close');
        assertReadAndClosed = () => {
          expect(read).toHaveBeenCalledTimes(1);
          expect(closed).toHaveBeenCalledTimes(1);
        };
      }
      return handle;
    });
    try {
      await expect(
        contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a_b' }, 'second'))
      ).rejects.toBe(failure);
      expect(await readFile(join(root, 'nodes', 'a_b.md'), 'utf8')).toBe('first');
      expect(await readFile(path, 'utf8')).toBe(originalMetadata);
      assertReadAndClosed();
    } finally {
      intercepted.mockRestore();
    }
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "unreadable regular metadata rejects without replacing another producer's output",
    async () => {
      await contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a.b' }, 'first'));
      const path = join(root, 'nodes', 'a_b.meta.json');
      const originalMetadata = await readFile(path, 'utf8');
      await chmod(path, 0o000);
      try {
        expect((await lstat(path)).isFile()).toBe(true);
        await expect(
          contained(() => writeNodeArtifact(root, { ...meta, nodeId: 'a_b' }, 'second'))
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(await readFile(join(root, 'nodes', 'a_b.md'), 'utf8')).toBe('first');
      } finally {
        await chmod(path, 0o600);
      }
      expect(await readFile(path, 'utf8')).toBe(originalMetadata);
    }
  );

  test.skipIf(process.platform === 'win32')(
    'refuses FIFO metadata without waiting for input',
    async () => {
      await mkdir(join(root, 'nodes'));
      const path = join(root, 'nodes', 'probe.meta.json');
      expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
      let released = false;
      // Bound a broken reader's wait so the regression fails without leaving blocked I/O.
      const release = setTimeout(() => {
        released = true;
        const descriptor = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
        writeSync(descriptor, JSON.stringify({ nodeId: 'another-node' }));
        closeSync(descriptor);
      }, 1000);
      try {
        await expect(contained(() => writeNodeArtifact(root, meta, 'output'))).rejects.toThrow(
          ArtifactWriteError
        );
        expect(released).toBe(false);
        expect((await lstat(path)).isFIFO()).toBe(true);
        expect(await readdir(join(root, 'nodes'))).toEqual(['probe.meta.json']);
      } finally {
        clearTimeout(release);
      }
    }
  );

  test('refuses directory metadata before replacing output', async () => {
    await mkdir(join(root, 'nodes', 'probe.meta.json'), { recursive: true });
    await writeFile(join(root, 'nodes', 'probe.md'), 'first');
    await expect(contained(() => writeNodeArtifact(root, meta, 'second'))).rejects.toThrow(
      ArtifactWriteError
    );
    expect(await readFile(join(root, 'nodes', 'probe.md'), 'utf8')).toBe('first');
  });

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

test('host-only collision checks still read ownership through metadata links', async () => {
  await mkdir(join(root, 'nodes'));
  const target = join(outside, 'sentinel');
  await writeFile(target, JSON.stringify({ nodeId: 'another-node' }));
  const path = join(root, 'nodes', 'probe.meta.json');
  await symlink(target, path);
  await expect(
    withContainerArtifactsRoot(undefined, () => writeNodeArtifact(root, meta, 'output'))
  ).rejects.toThrow('collision');
  expect((await lstat(path)).isSymbolicLink()).toBe(true);
  expect(await readdir(join(root, 'nodes'))).toEqual(['probe.meta.json']);
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
