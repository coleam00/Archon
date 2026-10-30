import { expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BUNDLED_VERSION } from '@archon/paths/bundled-build';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  workflowSourceManifestSchema,
  indexedSourceDigest,
  writeManifest,
  type IndexedWorkflowSourceManifest,
} from './workflow-source/manifest';
import {
  openWorkflowSource,
  verifyWorkflowSourceUnits,
  loadWorkflowSource,
} from './workflow-source/load';
import { DEFAULT_WORKFLOW_SOURCE_CONFIG } from './workflow-source/roots';
import {
  WorkflowSourceIntegrityError,
  WorkflowSourceUnavailableError,
} from './workflow-source/integrity';

const track = trackTempRoots();
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const packManifest = {
  schemaVersion: 1 as const,
  kind: 'workflow-pack' as const,
  name: 'other',
  description: 'Other pack',
  entrypoints: { run: 'run/run.yaml' },
};

async function fixture(): Promise<{ root: string; manifest: IndexedWorkflowSourceManifest }> {
  const root = track(await mkdtemp(join(tmpdir(), 'source-index-')));
  const put = async (
    path: string,
    content: string
  ): Promise<{ path: string; hash: string; size: number }> => {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    return {
      path: path.split('/').slice(1).join('/'),
      hash: hash(content),
      size: Buffer.byteLength(content),
    };
  };
  const project = await put('project/.archon/workflows/healthy.yaml', 'name: healthy\n');
  const pack = JSON.stringify(packManifest);
  await put('installed/acme.other/archon-plugin.json', pack);
  const manifest: IndexedWorkflowSourceManifest = {
    version: 3,
    engine_version: BUNDLED_VERSION,
    origin: '/authoring',
    captured_at: new Date(0).toISOString(),
    digest: '0'.repeat(64),
    file_count: 2,
    byte_count: project.size + Buffer.byteLength(pack),
    source_config: DEFAULT_WORKFLOW_SOURCE_CONFIG,
    scopes: ['project', 'installed'],
    installed_plugins: [
      { key: 'acme.other', id: 'acme/other', commit: 'a'.repeat(40), manifest: packManifest },
    ],
    units: [
      {
        root: 'installed/acme.other',
        files: [{ path: 'archon-plugin.json', hash: hash(pack), size: Buffer.byteLength(pack) }],
      },
      { root: 'project', files: [project] },
    ],
  };
  manifest.digest = indexedSourceDigest(manifest);
  await writeManifest(root, manifest);
  return { root, manifest };
}

const anchorFor = ({ root, manifest }: Awaited<ReturnType<typeof fixture>>) => ({
  root,
  digest: manifest.digest,
  config: manifest.source_config,
});

test('opening authenticates the index; selected verification never reads an unrelated payload', async () => {
  const source = await fixture();
  const anchor = anchorFor(source);
  const reader = fs.readFile;
  const cause = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'open' });
  const spy = spyOn(fs, 'readFile').mockImplementation(
    new Proxy(reader, {
      apply(target, _receiver, args: Parameters<typeof fs.readFile>) {
        if (String(args[0]).startsWith(join(source.root, 'installed')))
          return Promise.reject(cause);
        return target(...args);
      },
    })
  );
  try {
    expect((await openWorkflowSource(source.root, anchor.digest)).verifiedFiles).toBeUndefined();
    const selected = await verifyWorkflowSourceUnits(anchor, ['project']);
    expect([...selected.verifiedFiles]).toEqual([
      join(source.root, 'project/.archon/workflows/healthy.yaml'),
    ]);
    await expect(verifyWorkflowSourceUnits(anchor, ['installed/acme.other'])).rejects.toMatchObject(
      { name: 'WorkflowSourceUnavailableError', cause }
    );
    await expect(loadWorkflowSource(source.root, anchor.digest)).rejects.toBeInstanceOf(
      WorkflowSourceUnavailableError
    );
  } finally {
    spy.mockRestore();
  }
  expect((await loadWorkflowSource(source.root, anchor.digest)).verifiedFiles.size).toBe(2);
});

test('each payload verification rechecks bytes after an earlier successful read', async () => {
  const source = await fixture();
  const anchor = anchorFor(source);
  await verifyWorkflowSourceUnits(anchor, ['project']);
  await writeFile(join(source.root, 'project/.archon/workflows/healthy.yaml'), 'altered');
  await expect(verifyWorkflowSourceUnits(anchor, ['project'])).rejects.toBeInstanceOf(
    WorkflowSourceIntegrityError
  );
});

test.each(['extra file', 'missing file', 'symlink'] as const)(
  'a required unit refuses %s',
  async kind => {
    const source = await fixture();
    const file = join(source.root, 'project/.archon/workflows/healthy.yaml');
    if (kind === 'extra file') await writeFile(join(dirname(file), 'extra.yaml'), 'unexpected');
    else {
      await rm(file);
      if (kind === 'symlink')
        await symlink(join(source.root, 'installed/acme.other/archon-plugin.json'), file);
    }
    await expect(verifyWorkflowSourceUnits(anchorFor(source), ['project'])).rejects.toBeInstanceOf(
      kind === 'missing file' ? WorkflowSourceUnavailableError : WorkflowSourceIntegrityError
    );
  }
);

test('a symlink replacing a whole required unit cannot authorize external bytes', async () => {
  const source = await fixture();
  await rm(join(source.root, 'project'), { recursive: true });
  await symlink(join(source.root, 'installed/acme.other'), join(source.root, 'project'));
  await expect(verifyWorkflowSourceUnits(anchorFor(source), ['project'])).rejects.toBeInstanceOf(
    WorkflowSourceIntegrityError
  );
});

test.each([
  'source_config',
  'units',
  'installed_plugins',
  'origin',
  'captured_at',
  'engine_version',
  'unavailable_installed_workflows',
] as const)('the run commitment authenticates %s', async field => {
  const source = await fixture();
  const changed = structuredClone(source.manifest);
  switch (field) {
    case 'source_config':
      changed.source_config.load_default_commands = false;
      break;
    case 'units':
      changed.units[1].files[0].hash = 'f'.repeat(64);
      break;
    case 'installed_plugins':
      changed.installed_plugins[0].manifest.entrypoints = { other: 'other/other.yaml' };
      break;
    case 'origin':
      changed.origin = '/replacement';
      break;
    case 'captured_at':
      changed.captured_at = new Date(1).toISOString();
      break;
    case 'engine_version':
      changed.engine_version = 'replacement';
      break;
    case 'unavailable_installed_workflows':
      changed.unavailable_installed_workflows = ['acme/missing:run'];
      break;
  }
  await writeManifest(source.root, changed);
  await expect(openWorkflowSource(source.root, source.manifest.digest)).rejects.toBeInstanceOf(
    WorkflowSourceIntegrityError
  );
});

test('a self-consistent replacement cannot satisfy the run digest', async () => {
  const source = await fixture();
  const changed = { ...source.manifest, origin: '/replacement' };
  changed.digest = indexedSourceDigest(changed);
  await writeManifest(source.root, changed);
  await expect(openWorkflowSource(source.root, source.manifest.digest)).rejects.toThrow(
    'capture has been replaced'
  );
});

test('key order and undefined properties do not change the commitment; the workflow stamp is diagnostic', async () => {
  const { manifest } = await fixture();
  const reordered: IndexedWorkflowSourceManifest = {
    ...manifest,
    source_config: {
      load_default_commands: true,
      command_folder: undefined,
      load_default_workflows: true,
    },
    workflow_name: 'different',
    digest: 'f'.repeat(64),
  };
  expect(indexedSourceDigest(reordered)).toBe(manifest.digest);
});

test.each([
  'duplicate root',
  'overlapping root',
  'unknown root',
  'absolute path',
  'parent path',
  'backslash',
  'duplicate file',
  'unsorted files',
  'file count',
  'byte count',
  'missing scope',
  'duplicate plugin',
  'wrong key',
  'missing installed unit',
  'invalid hash',
  'negative size',
  'unknown field',
])('the v3 reader rejects %s before trusting the index', async kind => {
  const { manifest } = await fixture();
  const data = structuredClone(manifest);
  switch (kind) {
    case 'duplicate root':
      data.units.push(data.units[1]);
      break;
    case 'overlapping root':
      data.units.push({ root: 'project/nested', files: [] });
      break;
    case 'unknown root':
      data.units[1].root = 'surprise';
      break;
    case 'absolute path':
      data.units[1].files[0].path = '/outside';
      break;
    case 'parent path':
      data.units[1].files[0].path = '../outside';
      break;
    case 'backslash':
      data.units[1].files[0].path = 'a\\b';
      break;
    case 'duplicate file':
      data.units[1].files.push(data.units[1].files[0]);
      break;
    case 'unsorted files':
      data.units[1].files.push({ ...data.units[1].files[0], path: '!earlier' });
      break;
    case 'file count':
      data.file_count++;
      break;
    case 'byte count':
      data.byte_count++;
      break;
    case 'missing scope':
      data.scopes = ['project'];
      break;
    case 'duplicate plugin':
      data.installed_plugins.push(data.installed_plugins[0]);
      break;
    case 'wrong key':
      data.installed_plugins[0].key = 'different.other';
      break;
    case 'missing installed unit':
      data.units.shift();
      break;
    case 'invalid hash':
      data.units[1].files[0].hash = 'bad';
      break;
    case 'negative size':
      data.units[1].files[0].size = -1;
      break;
    case 'unknown field':
      Object.assign(data, { unknown: 'not authenticated' });
      break;
  }
  expect(workflowSourceManifestSchema.safeParse(data).success).toBe(false);
});

test('full verification rejects injected unindexed roots; selected verification cannot select them', async () => {
  const source = await fixture();
  await mkdir(join(source.root, 'global'));
  await expect(loadWorkflowSource(source.root, source.manifest.digest)).rejects.toThrow(
    'Unindexed source root'
  );
  await expect(verifyWorkflowSourceUnits(anchorFor(source), ['global'])).rejects.toThrow(
    'not in the authenticated index'
  );
});

test('a future manifest version fails clearly', async () => {
  const source = await fixture();
  const path = join(source.root, 'manifest.json');
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...Object(data), version: 99 }));
  await expect(openWorkflowSource(source.root)).rejects.toThrow(
    'not a shape this build understands'
  );
});

test.each([1, 2] as const)(
  'legacy v%s keeps aggregate verification and never rewrites its manifest',
  async version => {
    const source = await fixture();
    const { foldDigest, digestEntries } = await import('./workflow-source/manifest');
    const digest = foldDigest(await digestEntries(source.root));
    const legacy = {
      version,
      engine_version: BUNDLED_VERSION,
      origin: source.manifest.origin,
      captured_at: source.manifest.captured_at,
      digest,
      file_count: source.manifest.file_count,
      byte_count: source.manifest.byte_count,
      scopes: source.manifest.scopes,
      source_config: source.manifest.source_config,
      ...(version === 2
        ? { installed_plugins: [{ key: 'acme.other', id: 'acme/other', commit: 'a'.repeat(40) }] }
        : {}),
    };
    const file = join(source.root, 'manifest.json');
    const bytes = JSON.stringify(legacy);
    await writeFile(file, bytes);
    expect((await openWorkflowSource(source.root, digest)).verifiedFiles?.size).toBe(2);
    const reader = fs.readFile;
    const cause = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'open' });
    const fault = spyOn(fs, 'readFile').mockImplementation(
      new Proxy(reader, {
        apply(target, _receiver, args: Parameters<typeof fs.readFile>) {
          if (String(args[0]).startsWith(join(source.root, 'installed')))
            return Promise.reject(cause);
          return target(...args);
        },
      })
    );
    try {
      const anchor = { root: source.root, digest, config: legacy.source_config };
      await expect(verifyWorkflowSourceUnits(anchor, ['project'])).rejects.toMatchObject({
        name: 'WorkflowSourceUnavailableError',
        cause,
        message: expect.stringContaining('require the entire aggregate'),
      });
    } finally {
      fault.mockRestore();
    }
    expect(await readFile(file, 'utf8')).toBe(bytes);
  }
);

test('the legacy manifest discriminator rejects v3 rather than treating it as an older format', async () => {
  const { z } = await import('zod');
  const oldReaderDiscriminator = z.discriminatedUnion('version', [
    z.object({ version: z.literal(1) }),
    z.object({ version: z.literal(2) }),
  ]);
  const { manifest } = await fixture();
  expect(oldReaderDiscriminator.safeParse(manifest).success).toBe(false);
});
