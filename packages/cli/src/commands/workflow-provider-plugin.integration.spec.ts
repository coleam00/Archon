import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree, trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import type { ProviderManifest } from '@archon/plugin-manifest';
import { readReceipts } from '@archon/plugin-manifest/store';
import { loadProviderPlugins } from '@archon/core/providers/load-provider-plugins';
import { providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { parseProviderRunModel } from '@archon/provider-contract';
import { checkAssistantLogin } from './doctor';
import { pluginCommand, type PluginEnvironment } from './plugin';

const tempRoot = trackTempRoots();
const ID = 'owner/repo';
const entry = join(import.meta.dir, '../cli.ts');
const fixture = join(
  import.meta.dir,
  '../../../provider-contract/src/fixtures/test-provider/main.ts'
);
const suffix = process.platform === 'win32' ? '.exe' : '';
const executable = `archon-provider-test-provider${suffix}`;
const commits = new Map<string, string>();
const manifests = new Map<string, ProviderManifest>();
const assets = new Map<string, Uint8Array<ArrayBuffer>>();
let root: string;
let server: ReturnType<typeof Bun.serve>;
let binary: Uint8Array<ArrayBuffer>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' }
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
}

async function runnable(source: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const script = join(root, `${name}.js`);
  await writeFile(script, source);
  if (process.platform === 'win32') {
    if (!process.env.CI) throw new Error('Windows fixture compilation runs only in CI');
    const output = join(root, `${name}.exe`);
    const child = Bun.spawn([process.execPath, 'build', '--compile', script, '--outfile', output], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    return new Uint8Array(await readFile(output));
  }
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return new TextEncoder().encode(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-provider-release-'));
  const build = await Bun.build({ entrypoints: [fixture], target: 'bun' });
  if (!build.success) throw new Error('test provider bundle failed');
  binary = await runnable(await build.outputs[0].text(), 'provider');
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q');
  for (const tag of ['v1', 'v2', 'invalid']) {
    await git(repo, 'commit', '--allow-empty', '-qm', tag);
    await git(repo, 'tag', tag);
    const commit = await git(repo, 'rev-parse', 'HEAD');
    commits.set(tag, commit);
    manifests.set(commit, {
      schemaVersion: 1,
      kind: 'provider',
      name: 'test-provider',
      description: 'Deterministic test provider',
      executable: 'archon-provider-test-provider',
    });
    assets.set(tag, binary);
  }
  await git(repo, 'update-server-info');
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      if (path === '/owner/repo/releases/latest')
        return new Response(null, {
          status: 302,
          headers: { location: '/owner/repo/releases/tag/v1' },
        });
      const gitPath = /^\/owner\/repo\.git\/(.+)$/.exec(path);
      if (gitPath) {
        const file = Bun.file(join(repo, '.git', gitPath[1]));
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
      }
      const raw = /^\/raw\/owner\/repo\/([a-f0-9]{40})\/archon-plugin.json$/.exec(path);
      if (raw) return Response.json(manifests.get(raw[1]));
      const release = /^\/owner\/repo\/releases\/download\/([^/]+)\/(.+)$/.exec(path);
      const bytes = release && assets.get(release[1]);
      if (release && bytes) {
        const manifest = manifests.get(commits.get(release[1]) ?? '');
        if (!manifest) return new Response(null, { status: 404 });
        const releaseAsset = `${manifest.executable}-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}${suffix}`;
        if (release[2] === 'checksums.txt')
          return new Response(
            `${createHash('sha256').update(bytes).digest('hex')}  ${releaseAsset}\n`
          );
        if (release[2] === releaseAsset) return new Response(bytes);
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
  const home = tempRoot(await mkdtemp(join(tmpdir(), 'archon-provider-install-')));
  const project = join(home, 'project');
  await mkdir(project);
  return {
    pluginsDir: join(home, 'home', 'plugins'),
    projectDir: project,
    archonVersion: '0.11.1',
    githubUrl: server.url.origin,
    rawUrl: `${server.url.origin}/raw`,
  };
}

async function cli(
  env: PluginEnvironment,
  args: string[]
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env: {
      ...process.env,
      ARCHON_HOME: dirname(env.pluginsDir),
      ARCHON_TELEMETRY_DISABLED: '1',
      DATABASE_URL: '',
      ARCHON_LOG_LEVEL: 'error',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: out + err };
}

async function plugin(
  env: PluginEnvironment,
  command: string,
  args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const out = spyOn(console, 'log').mockImplementation(() => undefined);
  const err = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const code = await pluginCommand(command, args, env);
    return { code, out: out.mock.calls.flat().join('\n'), err: err.mock.calls.flat().join('\n') };
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

test(
  'release install registers a provider, runs a workflow, and removal rejects before a run or worktree',
  async () => {
    const env = await environment();
    expect(await pluginCommand('install', [ID], env)).toBe(0);
    const receipts = await readReceipts(env.pluginsDir);
    expect(receipts[0]).toMatchObject({
      manifest: { kind: 'provider' },
      descriptor: { id: 'test-provider' },
    });
    const registrations = await loadProviderPlugins(env.pluginsDir);
    expect(
      (
        await checkAssistantLogin({}, async () => ({
          assistant: registrations[0].id,
          model: 'echo-model',
          vendor: undefined,
          connectedVendors: [],
          provider: registrations[0].factory(),
        }))
      ).status
    ).toBe('pass');
    expect(parseProviderRunModel(registrations[0], 'echo-model')).toBe('echo-model');
    expect(() => parseProviderRunModel(registrations[0], '')).toThrow();
    await git(env.projectDir, 'init', '-q');
    await git(env.projectDir, 'commit', '--allow-empty', '-qm', 'initial');
    const workflowDir = join(env.projectDir, '.archon/workflows/echo');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'echo.yaml'),
      'name: echo\ndescription: Provider plugin proof\nprovider: test-provider\nnodes:\n  - id: echo\n    prompt: release-provider-echo\n'
    );
    const run = await cli(env, [
      'workflow',
      'run',
      'echo',
      '--cwd',
      env.projectDir,
      '--no-worktree',
    ]);
    expect(run.output).toContain('release-provider-echo');
    expect(run.code).toBe(0);
    const db = new Database(join(dirname(env.pluginsDir), 'archon.db'), { readonly: true });
    const count = (): number =>
      db.query<{ n: number }, []>('SELECT count(*) as n FROM remote_agent_workflow_runs').get()
        ?.n ?? 0;
    try {
      expect(count()).toBe(1);
      expect(
        db
          .query<
            { output: string },
            []
          >("SELECT json_extract(data, '$.node_output') AS output FROM remote_agent_workflow_events WHERE event_type = 'node_completed' AND step_name = 'echo'")
          .get()?.output
      ).toContain('release-provider-echo');
      for (const field of ['skills', 'plugins', 'mcp']) {
        await writeFile(
          join(workflowDir, 'echo.yaml'),
          `name: echo\ndescription: Unsupported capability\nprovider: test-provider\nnodes:\n  - id: echo\n    prompt: never-spend\n    ${field}: ${field === 'mcp' ? 'undeclared' : '[undeclared]'}\n`
        );
        const rejected = await cli(env, [
          'workflow',
          'run',
          'echo',
          '--cwd',
          env.projectDir,
          '--no-worktree',
        ]);
        expect(rejected.code).not.toBe(0);
        expect(rejected.output).toContain(field);
        expect(rejected.output).toContain('test-provider');
        expect(rejected.output).toContain('cannot load what the node names');
      }
      await writeFile(
        join(workflowDir, 'echo.yaml'),
        'name: echo\ndescription: Provider plugin proof\nprovider: test-provider\nnodes:\n  - id: echo\n    prompt: release-provider-echo\n'
      );
      expect(await pluginCommand('update', [`${ID}@v2`], env)).toBe(0);
      expect((await readReceipts(env.pluginsDir))[0].tag).toBe('v2');
      expect((await plugin(env, 'list', [])).out).toContain('owner/repo  provider  v2');
      const beforeRemoval = count();
      const beforeWorktrees = await git(env.projectDir, 'worktree', 'list', '--porcelain');
      expect(await pluginCommand('remove', [ID], env)).toBe(0);
      expect(await Bun.file(join(env.pluginsDir, executable)).exists()).toBe(false);
      expect(await loadProviderPlugins(env.pluginsDir)).toEqual([]);
      for (const args of [
        ['validate', 'workflows', 'echo'],
        ['workflow', 'run', 'echo'],
      ]) {
        const removed = await cli(env, [...args, '--cwd', env.projectDir]);
        expect(removed.code).not.toBe(0);
        expect(removed.output).toContain('test-provider');
        expect(removed.output.toLowerCase()).toContain('unknown provider');
      }
      expect(count()).toBe(beforeRemoval);
      expect(await git(env.projectDir, 'worktree', 'list', '--porcelain')).toBe(beforeWorktrees);
    } finally {
      db.close();
    }
  },
  testTimeout(60_000)
);

test(
  'invalid provider initialize, ids, capabilities and vendors preserve the previous install',
  async () => {
    const env = await environment();
    expect(await pluginCommand('install', [`${ID}@v1`], env)).toBe(0);
    const before = await snapshot(env.pluginsDir);
    const receipt = (await readReceipts(env.pluginsDir))[0];
    if (!('descriptor' in receipt)) throw new Error('missing descriptor');
    const descriptor = providerPluginDescriptorSchema.parse(receipt.descriptor);
    const caps = descriptor.capabilities;
    const cases = [
      { ...descriptor, id: 'mismatch' },
      { ...descriptor, id: 'claude' },
      { ...descriptor, credentials: { kind: 'dynamic' } },
      { ...descriptor, capabilities: { ...caps, nativeTools: true } },
      {
        ...descriptor,
        credentials: {
          kind: 'static',
          specs: [{ vendor: 'undeliverable', displayName: 'Bad vendor', kinds: ['api_key'] }],
        },
      },
      { ...descriptor, capabilities: { ...caps, sessionFork: true, sessionResume: false } },
      { ...descriptor, ownsUnprefixedModelRefs: true },
    ];
    const descriptorFile = join(root, 'invalid-descriptor.json');
    const invalidBinary = await runnable(
      `const descriptor = await Bun.file(${JSON.stringify(join(root, 'invalid-descriptor.json'))}).json(); for await (const line of console) { const request = JSON.parse(line); console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{_meta:{archon:descriptor}},authMethods:[]}})); }`,
      'invalid-provider'
    );
    for (const [index, value] of cases.entries()) {
      const id = value.id;
      manifests.set(commits.get('invalid') ?? '', {
        schemaVersion: 1,
        kind: 'provider',
        name: 'test-provider',
        description: 'Invalid provider',
        executable: `archon-provider-${id}`,
      });
      await writeFile(descriptorFile, JSON.stringify(value));
      assets.set('invalid', invalidBinary);
      if (index === 0)
        manifests.set(commits.get('invalid') ?? '', {
          schemaVersion: 1,
          kind: 'provider',
          name: 'test-provider',
          description: 'Invalid provider',
          executable: 'archon-provider-test-provider',
        });
      const rejected = await plugin(env, 'update', [`${ID}@invalid`]);
      expect(rejected.code).toBe(1);
      expect(rejected.err).toContain(
        [
          'descriptor id must match',
          'already registered',
          'failed initialize',
          'failed initialize',
          'no credential delivery rule',
          'sessionFork requires sessionResume',
          'already owns unprefixed model refs',
        ][index]
      );
      expect(await snapshot(env.pluginsDir)).toEqual(before);
    }
    assets.set('invalid', new TextEncoder().encode('broken executable'));
    expect(await pluginCommand('update', [`${ID}@invalid`], env)).toBe(1);
    expect(await snapshot(env.pluginsDir)).toEqual(before);
    const fresh = await environment();
    expect((await plugin(fresh, 'install', [`${ID}@invalid`])).code).toBe(1);
    expect(await readReceipts(fresh.pluginsDir)).toEqual([]);
    expect(await snapshot(fresh.pluginsDir)).toEqual({});
  },
  testTimeout(60_000)
);
