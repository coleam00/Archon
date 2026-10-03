/**
 * The workflow-node scope, proved on the real bundled Codex binary at zero spend.
 *
 * A temp CODEX_HOME holds a local marketplace with plugins `alpha` and `beta`. Each ships
 * an MCP server with one marker tool, a skill with a marker body, and a trusted
 * `UserPromptSubmit` hook that appends its name to a log. The home also has a user MCP
 * server and a user AGENTS.md, the repo a project AGENTS.md, and the model provider is a
 * localhost stub that records the request Codex would send a model and answers 400. Each
 * case asserts on that recorded request (tools, injected skill bodies, guidance) and on
 * the hook log, so it reads what a model would actually see.
 *
 * The temp home is the fixture under test; the provider never sets CODEX_HOME itself.
 * The binary is required: a missing one fails here rather than skipping.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import type { MessageChunk, SendQueryOptions } from '../types';
import { AppServerConnection } from './app-server';
import { resolveBundledCodexBinary } from './binary-resolver';
import { CodexProvider } from './provider';

/** A minimal MCP stdio server whose one tool is named `<argv[2]>_marker`. */
const MCP_STUB = `
const { createInterface } = require('node:readline');
const name = process.argv[2];
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: name + '_marker', description: 'marker', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

/** Appends `<argv[2]>` to the log at `<argv[3]>`: the plugin hooks' command. */
const HOOK_SCRIPT = `require('node:fs').appendFileSync(process.argv[3], process.argv[2] + '\\n');`;

let root: string;
let home: string;
let repo: string;
let hookLog: string;
let stub: ReturnType<typeof Bun.serve>;
let modelRequests: string[] = [];

const bun = process.execPath;
/** TOML basic strings take JSON string escapes, so a Windows path survives. */
const toml = (value: string): string => JSON.stringify(value);

/**
 * One hook-command argument. Codex runs a hook command with `sh -lc` on POSIX, where
 * single quotes are safe, and inside its own quotes with `cmd.exe /C` on Windows, where
 * nested quotes kept the hook from running on windows-latest. Windows arguments therefore
 * stay bare, and `beforeAll` refuses a path with whitespace there.
 */
function shellArg(arg: string): string {
  return process.platform === 'win32' ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** A `UserPromptSubmit` hook that logs `name`, in the shape plugin.json and hooks.json share. */
function promptHook(name: string): object {
  const command = [bun, join(root, 'hook.js'), name, hookLog].map(shellArg).join(' ');
  return { UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] };
}

function stdioServer(stubPath: string, name: string): { command: string; args: string[] } {
  return { command: bun, args: [stubPath, name] };
}

async function writePlugin(marketplace: string, name: string, stubPath: string): Promise<void> {
  const dir = join(marketplace, 'plugins', name);
  await mkdir(join(dir, '.codex-plugin'), { recursive: true });
  await mkdir(join(dir, 'skills', `${name}-skill`), { recursive: true });
  await writeFile(
    join(dir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      description: 'fixture',
      hooks: { hooks: promptHook(name) },
    })
  );
  await writeFile(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { [`${name}_srv`]: stdioServer(stubPath, name) } })
  );
  await writeFile(
    join(dir, 'skills', `${name}-skill`, 'SKILL.md'),
    `---\nname: ${name}-skill\ndescription: fixture skill ${name}\n---\nSay ${name}-MARKER\n`
  );
}

/** Installs both plugins into the temp home and trusts every hook, as an operator would. */
async function installPlugins(marketplaceFile: string): Promise<void> {
  const connection = AppServerConnection.start(resolveBundledCodexBinary(), [], {
    ...(process.env as Record<string, string>),
    CODEX_HOME: home,
  });
  try {
    await connection.request('initialize', {
      clientInfo: { name: 'archon-test', title: 'Archon test', version: '0' },
      capabilities: null,
    });
    connection.notify('initialized');
    for (const pluginName of ['alpha', 'beta']) {
      await connection.request('plugin/install', { marketplacePath: marketplaceFile, pluginName });
    }
    const listed = (await connection.request('hooks/list', { cwds: [repo] })) as {
      data: { hooks: { key: string; currentHash: string; pluginId: string | null }[] }[];
    };
    // Both plugin hooks and the user's own hook.
    const trust = listed.data
      .flatMap(entry => entry.hooks)
      .map(hook => `[hooks.state.${toml(hook.key)}]\ntrusted_hash = ${toml(hook.currentHash)}\n`);
    expect(trust).toHaveLength(3);
    appendFileSync(join(home, 'config.toml'), `\n${trust.join('\n')}`);
  } finally {
    await connection.shutdown(3000);
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-scope-boundary-'));
  home = join(root, 'home');
  repo = join(root, 'repo');
  hookLog = join(root, 'hooks.log');
  const unquotable = [bun, root].filter(path => /\s/.test(path));
  if (process.platform === 'win32' && unquotable.length > 0) {
    throw new Error(
      `The Windows hook command cannot hold a path with whitespace: ${unquotable.join(', ')}`
    );
  }
  const marketplace = join(root, 'marketplace');
  const stubPath = join(root, 'mcp-stub.js');
  await mkdir(home, { recursive: true });
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true });
  await writeFile(stubPath, MCP_STUB);
  await writeFile(join(root, 'hook.js'), HOOK_SCRIPT);
  await writeFile(join(home, 'AGENTS.md'), 'USER-GUIDANCE-MARKER\n');
  // The user's own hook, which every node keeps.
  await writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: promptHook('user') }));
  await writeFile(join(repo, 'AGENTS.md'), 'PROJECT-GUIDANCE-MARKER\n');
  for (const name of ['alpha', 'beta']) await writePlugin(marketplace, name, stubPath);
  const marketplaceFile = join(marketplace, '.agents', 'plugins', 'marketplace.json');
  await writeFile(
    marketplaceFile,
    JSON.stringify({
      name: 'fixture',
      plugins: ['alpha', 'beta'].map(name => ({
        name,
        source: { source: 'local', path: `./plugins/${name}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      })),
    })
  );

  stub = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method === 'POST') modelRequests.push(await request.text());
      return Response.json(
        { error: { message: 'stub model', type: 'invalid_request_error' } },
        { status: 400 }
      );
    },
  });
  const userServer = stdioServer(stubPath, 'user');
  await writeFile(
    join(home, 'config.toml'),
    [
      'model = "stub-model"',
      'model_provider = "stub"',
      '',
      '[model_providers.stub]',
      'name = "stub"',
      `base_url = ${toml(`http://127.0.0.1:${String(stub.port)}/v1`)}`,
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
      '[marketplaces.fixture]',
      'source_type = "local"',
      `source = ${toml(marketplace)}`,
      '',
      '[mcp_servers.user_srv]',
      `command = ${toml(userServer.command)}`,
      `args = [${userServer.args.map(toml).join(', ')}]`,
      '',
    ].join('\n')
  );
  await installPlugins(marketplaceFile);
}, testTimeout(60_000));

afterAll(async () => {
  await stub?.stop(true);
  if (root) await removeTempTree(root);
});

beforeEach(async () => {
  modelRequests = [];
  await rm(hookLog, { force: true });
});

/** Runs `body` with `lines` appended to the fixture's config.toml, then restores it. */
async function withUserConfig<T>(lines: string, body: () => Promise<T>): Promise<T> {
  const configPath = join(home, 'config.toml');
  const original = await readFile(configPath, 'utf8');
  await writeFile(configPath, `${original}\n${lines}\n`);
  try {
    return await body();
  } finally {
    await writeFile(configPath, original);
  }
}

const PROMPT = 'Use $alpha:alpha-skill and $beta:beta-skill.';

/** One workflow-node turn against the fixture home; returns its chunks. */
async function runNode(
  nodeConfig: SendQueryOptions['nodeConfig'],
  resumeSessionId?: string
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of new CodexProvider().sendQuery(PROMPT, repo, resumeSessionId, {
    // An empty CODEX_API_KEY keeps an operator's key from logging the stub provider in.
    env: { CODEX_HOME: home, CODEX_API_KEY: '' },
    nodeConfig: { nodeId: 'scoped', ...nodeConfig },
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

function resultOf(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'result' }> {
  const result = chunks.find(c => c.type === 'result');
  if (result?.type !== 'result') throw new Error('no result chunk');
  return result;
}

interface Seen {
  tools: string[];
  skills: string[];
  hooks: string[];
  guidance: boolean;
}

/** What the model would have seen on the turn's first request, and which hooks ran. */
async function seen(): Promise<Seen> {
  expect(modelRequests.length).toBeGreaterThan(0);
  const request = modelRequests[0];
  const hooks = (await readFile(hookLog, 'utf8').catch(() => ''))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  return {
    tools: ['alpha', 'beta', 'user', 'declared'].filter(name => request.includes(`${name}_marker`)),
    skills: ['alpha', 'beta'].filter(name => request.includes(`${name}-MARKER`)),
    hooks,
    guidance:
      request.includes('USER-GUIDANCE-MARKER') && request.includes('PROJECT-GUIDANCE-MARKER'),
  };
}

async function writeMcp(file: string, servers: Record<string, string>): Promise<void> {
  const stubPath = join(root, 'mcp-stub.js');
  await writeFile(
    join(repo, file),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(servers).map(([server, marker]) => [server, stdioServer(stubPath, marker)])
      )
    )
  );
}

/** What a node naming only `alpha@fixture` sees: alpha's skill and hook, the user's hook. */
const ALPHA_ONLY: Seen = { tools: [], skills: ['alpha'], hooks: ['alpha', 'user'], guidance: true };

describe('Codex workflow-node scope on the real binary', () => {
  test(
    'a node that names nothing sees no plugin tool, skill or hook, and keeps the user’s hook and both AGENTS.md',
    async () => {
      const chunks = await runNode({});
      expect(resultOf(chunks).failure?.evidence).toContain('stub model');
      expect(await seen()).toEqual({ tools: [], skills: [], hooks: ['user'], guidance: true });
    },
    testTimeout(20_000)
  );

  test(
    'a resumed thread gets the same scope',
    async () => {
      const sessionId = resultOf(await runNode({})).sessionId;
      expect(sessionId).toBeDefined();
      modelRequests = [];
      await rm(hookLog, { force: true });
      await runNode({}, sessionId);
      expect(await seen()).toEqual({ tools: [], skills: [], hooks: ['user'], guidance: true });
    },
    testTimeout(20_000)
  );

  test(
    'a named plugin brings its skill and hook, not its MCP server, and nothing from the other plugin',
    async () => {
      await runNode({ plugins: ['alpha@fixture'] });
      expect(await seen()).toEqual(ALPHA_ONLY);
    },
    testTimeout(20_000)
  );

  test(
    'a resumed thread keeps a named plugin’s scope',
    async () => {
      const sessionId = resultOf(await runNode({ plugins: ['alpha@fixture'] })).sessionId;
      expect(sessionId).toBeDefined();
      modelRequests = [];
      await rm(hookLog, { force: true });
      await runNode({ plugins: ['alpha@fixture'] }, sessionId);
      expect(await seen()).toEqual(ALPHA_ONLY);
    },
    testTimeout(20_000)
  );

  test(
    'a named plugin loads even when the user turned plugins off globally',
    async () => {
      await withUserConfig('[features]\nplugins = false', () =>
        runNode({ plugins: ['alpha@fixture'] })
      );
      expect(await seen()).toEqual(ALPHA_ONLY);
    },
    testTimeout(20_000)
  );

  test(
    'a named plugin’s server reaches the node only when its mcp: file declares it',
    async () => {
      await writeMcp('alpha-mcp.json', { alpha_srv: 'alpha' });
      await runNode({ plugins: ['alpha@fixture'], mcp: 'alpha-mcp.json' });
      expect((await seen()).tools).toEqual(['alpha']);
    },
    testTimeout(20_000)
  );

  test(
    'a node’s MCP servers are exactly its declared ones, without the user’s',
    async () => {
      await writeMcp('declared-mcp.json', { declared_srv: 'declared' });
      await runNode({ mcp: 'declared-mcp.json' });
      expect((await seen()).tools).toEqual(['declared']);
    },
    testTimeout(20_000)
  );

  test(
    'a named plugin that is not installed fails misconfigured before any model request',
    async () => {
      const result = resultOf(await runNode({ plugins: ['ghost@fixture'] }));
      expect(result.failure?.class).toBe('misconfigured');
      expect(result.failure?.evidence).toContain('ghost@fixture');
      expect(modelRequests).toEqual([]);
    },
    testTimeout(20_000)
  );
});
