// @archon-test-isolated
import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as paths from '@archon/paths';
import {
  removeTempTree,
  trackTempRoots,
  testTimeout,
  skipCompiledBinaryTests,
} from '@archon/paths/test-utils';
import {
  maintainedProviderPluginId,
  providerReceiptSchema,
  pluginReleaseAsset,
  type ProviderManifest,
} from '@archon/plugin-manifest';
import { MAINTAINED_PROVIDER_IDS } from '@archon/provider-contract';
import { maintainedDescriptors } from '@archon/providers';
import { createReleaseRepo, serveFixtureGit } from '../test-support/plugin-fixture';
import type { PluginEnvironment } from './plugin-common';

mock.module('@archon/paths', () => ({ ...paths, BUNDLED_IS_BINARY: true }));
const { receiptPath, scanReceipts } = await import('@archon/plugin-manifest/store');
const { providerCommand } = await import('./provider');
const { pluginCommand } = await import('./plugin');
const { installBinaryPlugin } = await import('./plugin-binary');
const { parsePluginRef } = await import('./plugin-source');
type MaintainedProviderId = (typeof MAINTAINED_PROVIDER_IDS)[number];
const windows = process.platform === 'win32';
const enabled = !windows || (!!process.env.CI && !skipCompiledBinaryTests());
const integration = enabled ? test : test.skip;
const suffix = windows ? '.exe' : '';
const version = '0.13.1';
const tag = `v${version}`;
const trackRoot = trackTempRoots();
let root: string;
let server: ReturnType<typeof Bun.serve>;
let config: string;
let oldMarker: string;
let compiledBytes: Uint8Array;
const artifacts = new Map<MaintainedProviderId, Uint8Array>();
let acquisitions = 0;
const log = spyOn(console, 'log').mockImplementation(() => undefined);
const error = spyOn(console, 'error').mockImplementation(() => undefined);

function manifest(provider: string): ProviderManifest {
  return {
    schemaVersion: 1,
    kind: 'provider',
    name: `provider-${provider}`,
    description: provider,
    executable: `archon-provider-${provider}`,
  };
}
function oldReceipt(provider: MaintainedProviderId) {
  return {
    schemaVersion: 1,
    id: maintainedProviderPluginId(provider),
    manifest: manifest(provider),
    descriptor: { ...maintainedDescriptors[provider], protocol: 2, version: '0.13.0' },
    tag: 'v0.13.0',
    commit: 'a'.repeat(40),
    installedAt: new Date(0).toISOString(),
    files: [{ path: `archon-provider-${provider}${suffix}`, sha256: 'b'.repeat(64) }],
  };
}
async function writeReceipt(env: PluginEnvironment, id: string, value: unknown) {
  const file = receiptPath(env.pluginsDir, id);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}
async function environment(
  providers: readonly MaintainedProviderId[] = MAINTAINED_PROVIDER_IDS
): Promise<PluginEnvironment> {
  const home = trackRoot(await fs.mkdtemp(join(tmpdir(), 'provider-upgrade-')));
  const env = {
    pluginsDir: join(home, 'plugins'),
    projectDir: home,
    archonVersion: version,
    githubUrl: server?.url.origin,
    rawUrl: `${server?.url.origin}/raw`,
  };
  for (const provider of providers) {
    const receipt = oldReceipt(provider);
    await writeReceipt(env, receipt.id, receipt);
    await fs.writeFile(
      join(env.pluginsDir, receipt.files[0].path),
      windows ? compiledBytes : `#!/bin/sh\nprintf executed > '${oldMarker}'\nexit 1\n`
    );
    await fs.chmod(join(env.pluginsDir, receipt.files[0].path), 0o755);
  }
  return env;
}
async function snapshot(env: PluginEnvironment) {
  const files = (await fs.readdir(env.pluginsDir, { recursive: true })).sort();
  const result: Record<string, string> = {};
  for (const file of files) {
    const path = join(env.pluginsDir, file);
    if ((await fs.stat(path)).isFile())
      result[file] = createHash('sha256')
        .update(await fs.readFile(path))
        .digest('hex');
  }
  return result;
}
function artifactFor(provider: MaintainedProviderId): Uint8Array {
  const artifact = artifacts.get(provider);
  if (!artifact) throw new Error(`Missing fixture artifact for ${provider}`);
  return artifact;
}
async function assertUpgraded(env: PluginEnvironment, provider: MaintainedProviderId) {
  const receipt = providerReceiptSchema.parse(
    JSON.parse(
      await fs.readFile(receiptPath(env.pluginsDir, maintainedProviderPluginId(provider)), 'utf8')
    )
  );
  expect(receipt.tag).toBe(tag);
  expect(receipt).toMatchObject({ descriptor: { id: provider, protocol: 3, version } });
  expect(await fs.readFile(join(env.pluginsDir, `archon-provider-${provider}${suffix}`))).toEqual(
    Buffer.from(artifactFor(provider))
  );
  expect(receipt.files[0].sha256).toBe(
    createHash('sha256').update(artifactFor(provider)).digest('hex')
  );
  expect(
    (await fs.readdir(env.pluginsDir, { recursive: true })).some(path => path.includes('.partial'))
  ).toBe(false);
}

beforeAll(async () => {
  if (!enabled) return;
  root = await fs.mkdtemp(join(tmpdir(), 'provider-release-'));
  config = join(root, 'config.json');
  oldMarker = join(root, 'old-executed');
  const script = join(root, 'fixture.js');
  await fs.writeFile(
    script,
    `
import { readFileSync, writeFileSync } from 'node:fs';
if (${windows} && !process.execPath.includes('.partial')) {
  writeFileSync(${JSON.stringify(oldMarker)}, 'executed');
  process.exit(1);
}
import { createInterface } from 'node:readline';
const provider = (process.argv[2] || process.execPath).match(/(?:^|-)(${MAINTAINED_PROVIDER_IDS.join('|')})(?:$|[.-])/)[1];
const descriptors = ${JSON.stringify(maintainedDescriptors)};
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method !== 'initialize') throw new Error('Only initialize is allowed');
  const protocol = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8')).protocol;
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: { _meta: { archon: { ...descriptors[provider], version: ${JSON.stringify(version)}, protocol } } }, authMethods: [] } }));
});
`
  );
  if (windows) {
    const output = join(root, 'fixture.exe');
    const child = Bun.spawn([process.execPath, 'build', '--compile', script, '--outfile', output], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code) throw new Error(stderr);
    compiledBytes = new Uint8Array(await fs.readFile(output));
  }
  const repo = join(root, 'repo');
  const commit = (await createReleaseRepo(repo, [{ tag }])).get(tag);
  for (const provider of MAINTAINED_PROVIDER_IDS) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    artifacts.set(
      provider,
      windows
        ? compiledBytes
        : new TextEncoder().encode(
            `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${provider}\n`
          )
    );
  }
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const git = await serveFixtureGit(repo, path, ['coleam00/Archon']);
      if (git) return git;
      for (const provider of MAINTAINED_PROVIDER_IDS) {
        const m = manifest(provider);
        if (
          path === `/raw/coleam00/Archon/${commit}/plugins/provider-${provider}/archon-plugin.json`
        )
          return Response.json(m);
      }
      const prefix = `/coleam00/Archon/releases/download/${tag}/`;
      if (path.startsWith(prefix)) {
        acquisitions++;
        const assets = MAINTAINED_PROVIDER_IDS.map(provider => ({
          data: artifactFor(provider),
          asset: pluginReleaseAsset(
            `archon-provider-${provider}`,
            `bun-${windows ? 'windows' : process.platform}-${process.arch}`
          ),
        }));
        if (path === prefix + 'checksums.txt')
          return new Response(
            assets
              .map(a => `${createHash('sha256').update(a.data).digest('hex')}  ${a.asset}`)
              .join('\n')
          );
        const artifact = assets.find(a => path === prefix + a.asset);
        if (artifact) return new Response(artifact.data);
      }
      return new Response(null, { status: 404 });
    },
  });
  await fs.writeFile(config, JSON.stringify({ protocol: 3 }));
}, testTimeout(60_000));
afterEach(() => {
  log.mockClear();
  error.mockClear();
});
afterAll(async () => {
  log.mockRestore();
  error.mockRestore();
  await server?.stop(true);
  if (root) await removeTempTree(root);
});

integration(
  'provider add replaces three protocol-2 providers in one command without launching them',
  async () => {
    const env = await environment();
    expect(
      await providerCommand('add', MAINTAINED_PROVIDER_IDS, env),
      error.mock.calls.flat().join('\n')
    ).toBe(0);
    for (const provider of MAINTAINED_PROVIDER_IDS) {
      await assertUpgraded(env, provider);
    }
    expect((await scanReceipts(env.pluginsDir)).broken).toEqual([]);
    expect(await Bun.file(oldMarker).exists()).toBe(false);
    expect(log.mock.calls.flat().join('\n')).not.toContain('File ownership could not be verified');
  },
  testTimeout(30_000)
);

integration(
  'plugin update replaces each provider while preserving untouched old peers',
  async () => {
    const env = await environment();
    const before = await snapshot(env);
    for (const [index, provider] of MAINTAINED_PROVIDER_IDS.entries()) {
      expect(
        await pluginCommand('update', [`${maintainedProviderPluginId(provider)}@${tag}`], env),
        error.mock.calls.flat().join('\n')
      ).toBe(0);
      await assertUpgraded(env, provider);
      if (index === 0) {
        const after = await snapshot(env);
        for (const peer of MAINTAINED_PROVIDER_IDS.slice(1)) {
          for (const path of [
            `archon-provider-${peer}${suffix}`,
            join('installed', ...maintainedProviderPluginId(peer).split('/'), 'receipt.json'),
          ])
            expect(after[path]).toBe(before[path]);
        }
      }
    }
  },
  testTimeout(30_000)
);

integration.each([2, 4])(
  'provider add preserves sole same-ID broken receipt repair (protocol %s)',
  async protocol => {
    const env = await environment(['claude']);
    const self = oldReceipt('claude');
    await writeReceipt(env, self.id, { ...self, descriptor: { ...self.descriptor, protocol } });
    expect(await providerCommand('add', ['claude'], env)).toBe(0);
    await assertUpgraded(env, 'claude');
  },
  testTimeout(15_000)
);

integration.each(['provider add', 'plugin update'] as const)(
  '%s refuses an old peer claiming the target with different case',
  async command => {
    const env = { ...(await environment(['claude', 'codex'])), platform: 'win32' as const };
    const self = oldReceipt('claude');
    const peer = oldReceipt('codex');
    const fileName = 'archon-provider-claude.exe';
    await writeReceipt(env, self.id, {
      ...self,
      files: [{ ...self.files[0], path: fileName }],
    });
    await writeReceipt(env, peer.id, {
      ...peer,
      files: [{ ...peer.files[0], path: fileName.toUpperCase() }],
    });
    await fs.writeFile(join(env.pluginsDir, fileName), 'old Windows binary');
    const before = await snapshot(env);
    const acquired = acquisitions;
    const code =
      command === 'provider add'
        ? await providerCommand('add', ['claude'], env)
        : await pluginCommand('update', [`${self.id}@${tag}`], env);
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('exists and may belong');
    expect(acquisitions).toBe(acquired);
    expect(await snapshot(env)).toEqual(before);
  }
);

for (const kind of ['provider', 'forge', 'chat'] as const) {
  for (const exactCase of [false, true]) {
    integration.each(['provider add', 'plugin update'] as const)(
      `%s refuses a current ${kind} owner of the Windows target (exact case=${exactCase})`,
      async command => {
        const env = { ...(await environment(['claude', 'codex'])), platform: 'win32' as const };
        const self = oldReceipt('claude');
        const fileName = 'archon-provider-claude.exe';
        await writeReceipt(env, self.id, {
          ...self,
          files: [{ ...self.files[0], path: fileName }],
        });
        const { descriptor, ...base } = oldReceipt('codex');
        const peers = {
          provider: { ...base, descriptor: { ...descriptor, protocol: 3 } },
          forge: {
            ...base,
            manifest: { ...base.manifest, kind: 'forge', executable: 'archon-forge-peer' },
          },
          chat: {
            ...base,
            manifest: { ...base.manifest, kind: 'chat', executable: 'archon-chat-peer' },
            descriptor: {
              protocol: 'archon-chat/1',
              id: 'peer',
              displayName: 'Peer',
              version: '1',
              capabilities: { defaultWorkflowDispatch: 'background' },
              policy: { workspaceRetention: 'age-based' },
            },
          },
        };
        const ownerId = 'acme/owner';
        await writeReceipt(env, ownerId, {
          ...peers[kind],
          id: ownerId,
          files: [{ ...base.files[0], path: exactCase ? fileName : fileName.toUpperCase() }],
        });
        expect((await scanReceipts(env.pluginsDir)).receipts).toMatchObject([
          { id: ownerId, manifest: { kind } },
        ]);
        await fs.writeFile(join(env.pluginsDir, fileName), 'old Windows binary');
        const before = await snapshot(env);
        const acquired = acquisitions;
        const code =
          command === 'provider add'
            ? await providerCommand('add', ['claude'], env)
            : await pluginCommand('update', [`${self.id}@${tag}`], env);
        expect(code).toBe(1);
        expect(error.mock.calls.flat().join('\n')).toContain(`belongs to ${ownerId}`);
        expect(acquisitions).toBe(acquired);
        expect(await snapshot(env)).toEqual(before);
      }
    );
  }
}

integration.each([
  'malformed self',
  'unreadable self',
  'mismatched self ID',
  'current owner',
  'old owner',
  'unrelated malformed',
  'unrelated unreadable',
  'missing target claim',
  'future self',
  'future peer',
  'community self',
  'noncanonical self',
] as const)('refuses %s before acquisition and preserves installed files', async scenario => {
  const env = await environment(['claude', 'codex']);
  const self = oldReceipt('claude');
  const peer = oldReceipt('codex');
  let selectedId = self.id;
  let unreadable: string | undefined;
  switch (scenario) {
    case 'malformed self':
      await writeReceipt(env, self.id, '{invalid');
      break;
    case 'unreadable self':
      unreadable = receiptPath(env.pluginsDir, self.id);
      break;
    case 'mismatched self ID':
      await writeReceipt(env, self.id, { ...self, id: 'acme/elsewhere' });
      break;
    case 'current owner':
      await writeReceipt(env, peer.id, {
        ...peer,
        files: self.files,
        descriptor: { ...maintainedDescriptors.codex, version },
      });
      break;
    case 'old owner':
      await writeReceipt(env, peer.id, { ...peer, files: self.files });
      break;
    case 'unrelated malformed':
      await writeReceipt(env, 'acme/broken', '{invalid');
      break;
    case 'unrelated unreadable':
      await writeReceipt(env, 'acme/unreadable', '{}');
      unreadable = receiptPath(env.pluginsDir, 'acme/unreadable');
      break;
    case 'missing target claim':
      await writeReceipt(env, self.id, {
        ...self,
        files: [{ ...self.files[0], path: 'another-file' }],
      });
      break;
    case 'future self':
      await writeReceipt(env, self.id, {
        ...self,
        descriptor: { ...self.descriptor, protocol: 4 },
      });
      break;
    case 'future peer':
      await writeReceipt(env, peer.id, {
        ...peer,
        descriptor: { ...peer.descriptor, protocol: 4 },
      });
      break;
    case 'community self':
      selectedId = 'acme/provider';
      await fs.rename(
        receiptPath(env.pluginsDir, self.id),
        receiptPath(env.pluginsDir, self.id) + '.old'
      );
      await writeReceipt(env, selectedId, { ...self, id: selectedId });
      break;
    case 'noncanonical self':
      await writeReceipt(env, self.id, {
        ...self,
        manifest: { ...self.manifest, executable: 'archon-provider-other' },
      });
      break;
  }
  const before = await snapshot(env);
  const acquired = acquisitions;
  // Inject at the read boundary: chmod cannot reliably deny reads to an administrator.
  const readFile = fs.readFile;
  const read = unreadable
    ? spyOn(fs, 'readFile').mockImplementation(
        new Proxy(readFile, {
          apply(target, thisArg, args) {
            if (args[0] === unreadable)
              return Promise.reject(
                Object.assign(new Error('receipt access denied'), { code: 'EACCES' })
              );
            return Reflect.apply(target, thisArg, args);
          },
        })
      )
    : undefined;
  try {
    const scan = await scanReceipts(env.pluginsDir);
    if (unreadable) {
      const unread = scan.broken.find(entry => entry.file === unreadable);
      expect(unread?.cause).toMatchObject({ code: 'EACCES' });
      expect(unread?.incompatibleProviderReceipt).toBeUndefined();
    }
    await expect(
      installBinaryPlugin(
        parsePluginRef(selectedId),
        { kind: 'provider', manifest: manifest('claude'), tag, commit: 'c'.repeat(40) },
        scan.receipts,
        scan.broken,
        undefined,
        env,
        async () => {
          acquisitions++;
          throw new Error('must not acquire');
        }
      )
    ).rejects.toThrow(scenario === 'current owner' ? 'belongs to' : 'exists and may belong');
  } finally {
    read?.mockRestore();
  }
  expect(acquisitions).toBe(acquired);
  expect(await snapshot(env)).toEqual(before);
});

integration.each([true, false])(
  'Windows target requires an exact .exe file claim (match=%s)',
  async match => {
    const env = await environment(['claude', 'codex']);
    const self = oldReceipt('claude');
    const fileName = 'archon-provider-claude.exe';
    await writeReceipt(env, self.id, {
      ...self,
      files: [{ ...self.files[0], path: match ? fileName : 'archon-provider-claude' }],
    });
    await fs.writeFile(join(env.pluginsDir, fileName), 'old Windows binary');
    const before = await snapshot(env);
    const scan = await scanReceipts(env.pluginsDir);
    await expect(
      installBinaryPlugin(
        parsePluginRef(self.id),
        { kind: 'provider', manifest: manifest('claude'), tag, commit: 'c'.repeat(40) },
        scan.receipts,
        scan.broken,
        undefined,
        { ...env, platform: 'win32' },
        async () => {
          throw new Error('acquisition reached');
        }
      )
    ).rejects.toThrow(match ? 'acquisition reached' : 'exists and may belong');
    expect(await snapshot(env)).toEqual(before);
  }
);

integration(
  'an incompatible staged handshake preserves all old files',
  async () => {
    const env = await environment();
    const before = await snapshot(env);
    await fs.writeFile(config, JSON.stringify({ protocol: 2 }));
    try {
      expect(await providerCommand('add', ['claude'], env)).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('plugin speaks protocol 2');
      expect(await snapshot(env)).toEqual(before);
      expect(await Bun.file(oldMarker).exists()).toBe(false);
    } finally {
      await fs.writeFile(config, JSON.stringify({ protocol: 3 }));
    }
  },
  testTimeout(15_000)
);
