import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeTempTree,
  trackTempRoots,
  testTimeout,
  skipCompiledBinaryTests,
} from '@archon/paths/test-utils';
import { providerCapabilitiesSchema } from '@archon/provider-contract';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { isChatReceipt, pluginReleaseAsset, type ChatManifest } from '@archon/plugin-manifest';
import { readReceipts, receiptPath, packTreePath } from '@archon/plugin-manifest/store';
import { loadProviderPlugins } from '@archon/core/providers/load-provider-plugins';
import { listInstalledPacks } from '@archon/workflows/workflow-source';
import { CLIAdapter } from '../adapters/cli-adapter';
import { GitHubAdapter } from '@archon/adapters';
import { GiteaAdapter } from '@archon/adapters/community/forge/gitea';
import { GitLabAdapter } from '@archon/adapters/community/forge/gitlab';
import { RESERVED_CHAT_PLATFORMS } from '@archon/chat-contract/descriptor';
import { pluginCommand, type PluginEnvironment } from './plugin';

const windows = process.platform === 'win32';
const enabled = !windows || (!!process.env.CI && !skipCompiledBinaryTests());
// Each install spawns the fixture; on Windows that is a fresh compiled executable, and
// these tests run several installs in series, so their budgets match the provider plugin
// integration tests rather than the single-spawn Windows floor.
const integration = enabled ? test : test.skip;
const trackRoot = trackTempRoots();
const suffix = windows ? '.exe' : '';
const descriptor = {
  protocol: 'archon-chat/1',
  id: 'slack',
  displayName: 'Fixture chat',
  version: '1',
  capabilities: { defaultWorkflowDispatch: 'background', resultFooter: true, runEvents: true },
  policy: { workspaceRetention: 'age-based' },
  allowlist: { envVar: 'FIXTURE_ALLOWED' },
  workflowCommand: { prefix: '/fixture ' },
};
const sentinel = 'SECRET-TOKEN-AND-USER-MESSAGE';
let root: string;
let repo: string;
let config: string;
let marker: string;
let server: ReturnType<typeof Bun.serve>;
let bytes: Uint8Array<ArrayBuffer>;
let brokenChecksum = false;
let brokenExecutable = false;
let latest = 'v1';
const commits = new Map<string, string>();
const manifests = new Map<string, ChatManifest>();

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd: repo, stdout: 'pipe', stderr: 'pipe' }
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}

beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(join(tmpdir(), 'archon-chat-release-'));
  repo = join(root, 'repo');
  config = join(root, 'config.json');
  marker = join(root, 'initialize.json');
  const script = join(root, 'fixture.js');
  await writeFile(
    script,
    `
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const config = JSON.parse(readFileSync(${JSON.stringify(config)}, 'utf8'));
process.stderr.write(${JSON.stringify(sentinel)});
if (config.mode === 'eof') process.exit(1);
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, method: request.method, params: request.params}));
  if (request.method !== 'initialize') throw new Error('start must not be called');
  const response = config.mode === 'remote-error'
    ? { error: { code: -32000, message: ${JSON.stringify(sentinel)}, data: ${JSON.stringify(sentinel)} } }
    : { result: config.descriptor };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response }));
});
setInterval(() => {}, 1000);
`
  );
  if (windows) {
    const output = join(root, 'fixture.exe');
    const child = Bun.spawn([process.execPath, 'build', '--compile', script, '--outfile', output], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(err);
    bytes = new Uint8Array(await readFile(output));
  } else {
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    bytes = new TextEncoder().encode(
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`
    );
  }
  await mkdir(repo);
  await git('init', '-q');
  for (const tag of ['v1', 'v2']) {
    await git('commit', '--allow-empty', '-qm', tag);
    await git('tag', tag);
    const commit = await git('rev-parse', 'HEAD');
    commits.set(tag, commit);
    manifests.set(commit, {
      schemaVersion: 1,
      kind: 'chat',
      name: 'fixture',
      description: 'Test chat',
      executable: tag === 'v2' ? 'archon-chat-renamed' : 'archon-chat-fixture',
    });
  }
  await git('update-server-info');
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path === '/owner/repo/releases/latest')
        return new Response(null, {
          status: 302,
          headers: { location: `/owner/repo/releases/tag/${latest}` },
        });
      const gitPath = /^\/owner\/repo\.git\/(.+)$/.exec(path);
      if (gitPath) {
        const file = Bun.file(join(repo, '.git', gitPath[1]));
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      }
      const raw = /^\/raw\/owner\/repo\/([a-f0-9]{40})(?:\/alternate)?\/archon-plugin.json$/.exec(
        path
      );
      if (raw) {
        const manifest = manifests.get(raw[1]);
        return Response.json(
          path.includes('/alternate/')
            ? { ...manifest, executable: 'archon-chat-alternate' }
            : manifest
        );
      }
      const release = /^\/owner\/repo\/releases\/download\/([^/]+)\/(.+)$/.exec(path);
      if (release) {
        const manifest = manifests.get(commits.get(release[1]) ?? '');
        if (manifest) {
          const executable = release[2].startsWith('archon-chat-alternate')
            ? 'archon-chat-alternate'
            : manifest.executable;
          const asset = pluginReleaseAsset(
            executable,
            `bun-${windows ? 'windows' : process.platform}-${process.arch}`
          );
          const data = brokenExecutable ? new TextEncoder().encode('broken executable') : bytes;
          if (release[2] === 'checksums.txt') {
            const digest = brokenChecksum
              ? '0'.repeat(64)
              : createHash('sha256').update(data).digest('hex');
            return new Response(
              [manifest.executable, 'archon-chat-alternate']
                .map(
                  name =>
                    `${digest}  ${pluginReleaseAsset(name, `bun-${windows ? 'windows' : process.platform}-${process.arch}`)}\n`
                )
                .join('')
            );
          }
          if (release[2] === asset) return new Response(data);
        }
      }
      return new Response(null, { status: 404 });
    },
  });
}, testTimeout(60_000));

afterAll(async () => {
  await server?.stop(true);
  if (root) await removeTempTree(root);
});

async function environment(): Promise<PluginEnvironment> {
  const home = trackRoot(await mkdtemp(join(tmpdir(), 'archon-chat-install-')));
  return {
    pluginsDir: join(home, 'plugins'),
    projectDir: home,
    archonVersion: '0.11.1',
    githubUrl: server.url.origin,
    rawUrl: `${server.url.origin}/raw`,
  };
}

async function configure(id = 'slack', mode = 'valid'): Promise<void> {
  brokenChecksum = false;
  brokenExecutable = false;
  latest = 'v1';
  await writeFile(config, JSON.stringify({ mode, descriptor: { ...descriptor, id } }));
}

async function command(
  env: PluginEnvironment,
  action: string,
  id?: string
): Promise<{ code: number; output: string }> {
  const out = spyOn(console, 'log').mockImplementation(() => undefined);
  const err = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await pluginCommand(action, id ? [id] : [], env);
    return { code, output: [...out.mock.calls.flat(), ...err.mock.calls.flat()].join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true })) {
    const file = Bun.file(join(dir, entry));
    if (await file.exists())
      result[entry] = createHash('sha256')
        .update(await file.bytes())
        .digest('hex');
  }
  return result;
}

integration(
  'release install initializes only, records provenance, updates, lists and removes owned files',
  async () => {
    const env = await environment();
    await configure();
    const installed = await command(env, 'install', 'owner/repo');
    expect(installed.code).toBe(0);
    expect(installed.output).not.toContain(sentinel);
    const receipts = await readReceipts(env.pluginsDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: 'owner/repo',
      tag: 'v1',
      commit: commits.get('v1'),
      descriptor,
      files: [
        {
          path: `archon-chat-fixture${suffix}`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    });
    expect(isChatReceipt(receipts[0])).toBe(true);
    const initialized = await Bun.file(marker).json();
    expect(initialized).toMatchObject({ method: 'initialize', params: {} });
    expect(() => process.kill(initialized.pid, 0)).toThrow();
    expect((await command(env, 'list')).output).toContain('owner/repo  chat  v1');
    expect((await command(env, 'copy', 'owner/repo')).output).toContain('only workflow packs copy');
    await writeFile(config, JSON.stringify({ descriptor: { ...descriptor, version: '2' } }));
    latest = 'v2';
    expect((await command(env, 'update', 'owner/repo')).code).toBe(0);
    expect((await readReceipts(env.pluginsDir))[0]).toMatchObject({
      tag: 'v2',
      descriptor: { id: 'slack', version: '2' },
      files: [{ path: `archon-chat-renamed${suffix}` }],
    });
    expect(await Bun.file(join(env.pluginsDir, `archon-chat-fixture${suffix}`)).exists()).toBe(
      false
    );
    const unrelated = join(env.pluginsDir, 'manually-installed');
    await writeFile(unrelated, 'keep');
    expect((await command(env, 'remove', 'owner/repo')).code).toBe(0);
    expect(await readReceipts(env.pluginsDir)).toEqual([]);
    expect(await Bun.file(join(env.pluginsDir, `archon-chat-renamed${suffix}`)).exists()).toBe(
      false
    );
    expect(await Bun.file(receiptPath(env.pluginsDir, 'owner/repo')).exists()).toBe(false);
    expect(await Bun.file(unrelated).text()).toBe('keep');
  },
  120_000
);

integration(
  'platform collisions name both owners, including another owner during an update',
  async () => {
    const env = await environment();
    await configure();
    expect((await command(env, 'install', 'owner/repo')).code).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const collision = await command(env, 'install', 'owner/repo/alternate');
    expect(collision.code).toBe(1);
    expect(collision.output).toContain('owner/repo/alternate collides with owner/repo');
    expect(await snapshot(env.pluginsDir)).toEqual(before);
    await configure('second-chat');
    expect((await command(env, 'install', 'owner/repo/alternate')).code).toBe(0);
    await configure('slack');
    const beforeUpdate = await snapshot(env.pluginsDir);
    const refused = await command(env, 'update', 'owner/repo/alternate@v2');
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('owner/repo/alternate collides with owner/repo');
    expect(await snapshot(env.pluginsDir)).toEqual(beforeUpdate);
  },
  120_000
);

integration(
  'every reserved host identity is refused with its owner',
  async () => {
    for (const [id, owner] of RESERVED_CHAT_PLATFORMS) {
      const env = await environment();
      await configure(id);
      const result = await command(env, 'install', 'owner/repo@v1');
      expect(result.code).toBe(1);
      expect(result.output).toContain(`Chat platform ${id}: owner/repo collides with ${owner}`);
      expect(await snapshot(env.pluginsDir)).toEqual({});
    }
  },
  120_000
);

integration(
  'checksum, executable, descriptor and remote failures leave fresh installs and updates unchanged without leaking payloads',
  async () => {
    for (const failure of ['checksum', 'executable', 'protocol', 'policy', 'remote-error', 'eof']) {
      for (const update of [false, true]) {
        const env = await environment();
        await configure();
        if (update) expect((await command(env, 'install', 'owner/repo@v1')).code).toBe(0);
        await mkdir(env.pluginsDir, { recursive: true });
        const before = await snapshot(env.pluginsDir);
        const previousMarker = await Bun.file(marker)
          .text()
          .catch(() => undefined);
        if (failure === 'checksum') brokenChecksum = true;
        else if (failure === 'executable') brokenExecutable = true;
        else if (failure === 'protocol' || failure === 'policy')
          await writeFile(
            config,
            JSON.stringify({
              descriptor: { ...descriptor, [failure]: failure === 'protocol' ? sentinel : {} },
            })
          );
        else await configure('slack', failure);
        const result = await command(
          env,
          update ? 'update' : 'install',
          `owner/repo@${update ? 'v2' : 'v1'}`
        );
        expect(result.code).toBe(1);
        expect(result.output).not.toContain(sentinel);
        expect(await snapshot(env.pluginsDir)).toEqual(before);
        if (failure === 'checksum')
          expect(
            await Bun.file(marker)
              .text()
              .catch(() => undefined)
          ).toBe(previousMarker);
      }
    }
  },
  180_000
);

integration('chat receipts do not interfere with provider and pack discovery', async () => {
  const env = await environment();
  await configure();
  expect((await command(env, 'install', 'owner/repo@v1')).code).toBe(0);
  const provider = {
    schemaVersion: 1,
    id: 'owner/provider',
    tag: 'v1',
    commit: 'a'.repeat(40),
    installedAt: new Date().toISOString(),
    manifest: {
      schemaVersion: 1,
      kind: 'provider',
      name: 'fixture-provider',
      description: 'Fixture',
      executable: 'archon-provider-example',
    },
    files: [{ path: `archon-provider-example${suffix}`, sha256: 'b'.repeat(64) }],
    descriptor: providerPluginDescriptorSchema.parse({
      protocol: 1,
      id: 'example',
      displayName: 'Example',
      version: '1',
      credentials: { kind: 'static', specs: [] },
      configSchema: { type: 'object' },
      capabilities: {
        ...Object.fromEntries(
          Object.keys(providerCapabilitiesSchema.shape).map(key => [key, false])
        ),
        backgroundWork: 'none',
        sessionFork: undefined,
        knownToolNames: undefined,
        renamedTools: undefined,
      },
    }),
  };
  const pack = {
    schemaVersion: 1,
    id: 'owner/pack',
    tag: 'v1',
    commit: 'b'.repeat(40),
    installedAt: new Date().toISOString(),
    manifest: {
      schemaVersion: 1,
      kind: 'workflow-pack',
      name: 'fixture-pack',
      description: 'Fixture',
      entrypoints: { review: 'review/review.yaml' },
    },
  };
  for (const receipt of [provider, pack]) {
    const file = receiptPath(env.pluginsDir, receipt.id);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(receipt));
  }
  const packDir = packTreePath(env.pluginsDir, pack.id, pack.commit);
  await mkdir(packDir, { recursive: true });
  await writeFile(join(packDir, 'archon-plugin.json'), JSON.stringify(pack.manifest));
  expect(await readReceipts(env.pluginsDir)).toHaveLength(3);
  expect((await loadProviderPlugins(env.pluginsDir)).map(provider => provider.id)).toEqual([
    'example',
  ]);
  const discovered = await listInstalledPacks({ kind: 'receipts', pluginsDir: env.pluginsDir });
  expect(discovered.errors).toEqual([]);
  expect(discovered.packs.map(pack => pack.record?.id)).toEqual(['owner/pack']);
});

// The server owns WebAdapter and proves its identity in its own adapter tests.
test('reserved identities conform to bundled adapters', () => {
  for (const adapter of [CLIAdapter, GitHubAdapter, GiteaAdapter, GitLabAdapter]) {
    expect(RESERVED_CHAT_PLATFORMS.get(adapter.prototype.getPlatformType())).toBeDefined();
  }
  expect([...RESERVED_CHAT_PLATFORMS.keys()].sort()).toEqual([
    'api',
    'cli',
    'gitea',
    'github',
    'gitlab',
    'web',
  ]);
});
