/**
 * Capability scope, proved on the real bundled Codex binary at zero spend.
 *
 * A temp CODEX_HOME holds a local marketplace with plugins `alpha` and `beta`. Each ships
 * an MCP server with one marker tool, a skill with a marker body, and a trusted
 * `UserPromptSubmit` hook that appends its name to a log. The home also has a user MCP
 * server and a user AGENTS.md, the repo a project AGENTS.md, and the model provider is a
 * localhost stub that records the request Codex would send a model and answers 400. Each
 * case asserts on that recorded request (tools, injected skill bodies, guidance) and on
 * the hook log, so it reads what a model would actually see.
 *
 * The stub provider requires OpenAI auth and the ChatGPT backend points at the same stub,
 * so the recorded request also carries the credential each auth path logged Codex in with
 * and no model request or credential leaves localhost. Codex's own curated-plugin sync
 * still fetches from GitHub; see `CODEX_SCRATCH_DIR`.
 *
 * The temp home is the fixture under test; the provider never sets CODEX_HOME itself.
 * `beforeAll` builds it once as a template, and each test runs on its own copy, so what
 * one test writes there never reaches the next. A test that ends with a run still in
 * flight, as a timed-out one does, gets that run's timeline printed and the run stopped
 * before the next test starts. The binary is required: a missing one fails here rather
 * than skipping.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import type { MessageChunk, SendQueryOptions } from '../types';
import { AppServerConnection, settlesWithin, type Spawner } from './app-server';
import { resolveBundledCodexBinary } from './binary-resolver';
import { CODEX_CREDENTIAL_ENV } from './credential-env';
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

const TEMPLATE_DIR = 'template-home';
/**
 * Codex's scratch directory in a home. Every app-server start syncs the curated plugins
 * there with `git`. The provider stops that fetch if it outlives app-server, leaving
 * unfinished sync state. The template's copies leave scratch out; no case reads it,
 * and the installed plugins live in `plugins/cache`.
 */
const CODEX_SCRATCH_DIR = '.tmp';

let root: string;
/** The home `beforeAll` builds, with the plugins installed and trusted. */
let template: string;
/** The trust key Codex gave the user's own hook in the template. */
let userHookKey: string;
/** This test's copy of the template. */
let home: string;
let repo: string;
let hookLog: string;
let stub: ReturnType<typeof Bun.serve>;
/** A model request as the stub received it, with the credential headers it carried. */
interface ModelRequest {
  body: string;
  authorization: string | null;
  accountId: string | null;
}
let modelRequests: ModelRequest[] = [];
let modelReply: (() => Response | Promise<Response>) | undefined;
/** The request an unscoped turn sends: the control a scoped request is compared against. */
let unscopedRequest: string;

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
    const hooks = listed.data.flatMap(entry => entry.hooks);
    expect(hooks).toHaveLength(3);
    const userHook = hooks.find(hook => hook.pluginId === null);
    if (!userHook) throw new Error('the user hook is not listed');
    userHookKey = userHook.key;
    const trust = hooks.map(
      hook => `[hooks.state.${toml(hook.key)}]\ntrusted_hash = ${toml(hook.currentHash)}\n`
    );
    appendFileSync(join(home, 'config.toml'), `\n${trust.join('\n')}`);
  } finally {
    await connection.shutdown(3000);
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-scope-boundary-'));
  template = join(root, TEMPLATE_DIR);
  home = template;
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
  await mkdir(join(home, 'skills', 'ambient-fixture'), { recursive: true });
  await writeFile(
    join(home, 'skills', 'ambient-fixture', 'SKILL.md'),
    '---\nname: ambient-fixture\ndescription: AMBIENT-CATALOGUE-MARKER\n---\nAMBIENT-BODY-MARKER\n'
  );
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
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/responses')) {
        modelRequests.push({
          body: await request.text(),
          authorization: request.headers.get('authorization'),
          accountId: request.headers.get('chatgpt-account-id'),
        });
        mark(`model request ${String(modelRequests.length)}`);
        if (modelReply) return modelReply();
      }
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
      `chatgpt_base_url = ${toml(`http://127.0.0.1:${String(stub.port)}/backend-api/`)}`,
      '',
      '[model_providers.stub]',
      'name = "stub"',
      `base_url = ${toml(`http://127.0.0.1:${String(stub.port)}/v1`)}`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
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
  // The first unscoped turn on a fresh home pays a one-time cost: on windows-latest it
  // took 6 to 18 s, against 2 to 4 s for each later one. Taking it here, under the setup
  // budget and on the template, means every case copies a home that has run a turn.
  await runRequest({});
  unscopedRequest = modelRequests[0]?.body ?? '';
}, testTimeout(60_000));

afterAll(async () => {
  await stub?.stop(true);
  if (root) await removeTempTree(root);
});

beforeEach(async () => {
  home = await mkdtemp(join(root, 'home-'));
  await cp(template, home, {
    recursive: true,
    filter: source => relative(template, source) !== CODEX_SCRATCH_DIR,
  });
  const configPath = join(home, 'config.toml');
  await writeFile(configPath, trustCopiedUserHook(await readFile(configPath, 'utf8'), home));
  modelRequests = [];
  modelReply = undefined;
  testStart = performance.now();
  timeline = [];
  appServers = [];
  await rm(hookLog, { force: true });
});

afterEach(async () => {
  const leftRunning = [...inFlight];
  if (leftRunning.length > 0) {
    console.error(inFlightReport(leftRunning.length));
    for (const run of leftRunning) run.abort.abort();
    await Promise.all(leftRunning.map(run => run.settled));
  }
  await removeTempTree(home);
}, testTimeout(20_000));

/**
 * Codex keys the user hook's trust by the path of the hooks.json that holds it, so a copy
 * of the template trusts its own. The copy sits beside the template, so its key is the
 * template's with the directory name swapped, in whatever path form Codex wrote.
 */
function trustCopiedUserHook(config: string, copy: string): string {
  const at = userHookKey.lastIndexOf(TEMPLATE_DIR);
  if (at < 0 || !config.includes(toml(userHookKey))) {
    throw new Error(`Cannot find the template's user hook trust key ${userHookKey}`);
  }
  const copyKey = `${userHookKey.slice(0, at)}${basename(copy)}${userHookKey.slice(at + TEMPLATE_DIR.length)}`;
  return config.replace(toml(userHookKey), toml(copyKey));
}

/** A run `runRequest` started that has not finished. */
interface InFlightRun {
  abort: AbortController;
  settled: Promise<unknown>;
}
const inFlight = new Set<InFlightRun>();

/** This test's events, each stamped with the milliseconds since it started. */
let timeline: string[] = [];
let testStart = 0;
function mark(event: string): void {
  timeline.push(`+${String(Math.round(performance.now() - testStart))}ms ${event}`);
}

/** The app-server processes this test started, with the tail of each one's stderr. */
let appServers: { pid: number | undefined; stderr: string }[] = [];

/** Starts app-server as the provider would, recording its start, exit and stderr. */
const recordingSpawner: Spawner = (command, args, options) => {
  const child = spawn(command, args, options);
  const server = { pid: child.pid, stderr: '' };
  appServers.push(server);
  mark(`app-server ${String(child.pid)} started`);
  child.stderr.on('data', (chunk: Buffer | string) => {
    server.stderr = (server.stderr + String(chunk)).slice(-2000);
  });
  child.once('close', (code, signal) => {
    mark(`app-server ${String(child.pid)} exited (${String(signal ?? code)})`);
  });
  return child;
};

/** What a test that ended with runs in flight had reached: its timeline and Codex's stderr. */
function inFlightReport(count: number): string {
  const stderr = appServers.map(
    ({ pid, stderr: tail }) => `app-server ${String(pid)} stderr:\n${tail.trim() || '(empty)'}`
  );
  return [
    `${String(count)} Codex run(s) still in flight when the test ended; stopping them.`,
    'Timeline:',
    ...timeline,
    ...stderr,
  ].join('\n');
}

/** Adds `lines` to this test's config.toml. Top-level keys go first, because the file ends inside a table. */
async function addUserConfig(
  lines: string,
  placement: 'append' | 'prepend' = 'append'
): Promise<void> {
  const configPath = join(home, 'config.toml');
  const original = await readFile(configPath, 'utf8');
  await writeFile(
    configPath,
    placement === 'append' ? `${original}\n${lines}\n` : `${lines}\n${original}`
  );
}

const PROMPT = 'Use $alpha:alpha-skill and $beta:beta-skill.';

/** One workflow-node turn against the fixture home; returns its chunks. */
async function runNode(
  nodeConfig: SendQueryOptions['nodeConfig'],
  resumeSessionId?: string,
  forkSession?: boolean
): Promise<MessageChunk[]> {
  return await runRequest(
    { nodeConfig: { nodeId: 'scoped', ...nodeConfig }, forkSession },
    resumeSessionId
  );
}

let runCount = 0;

async function runRequest(
  options: SendQueryOptions,
  resumeSessionId?: string
): Promise<MessageChunk[]> {
  const abort = new AbortController();
  const chunks = collectChunks(`run ${String(++runCount)}`, abort.signal, options, resumeSessionId);
  const run = { abort, settled: chunks.catch(() => undefined) };
  inFlight.add(run);
  try {
    return await chunks;
  } finally {
    inFlight.delete(run);
  }
}

async function collectChunks(
  label: string,
  abortSignal: AbortSignal,
  options: SendQueryOptions,
  resumeSessionId: string | undefined
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  const { env, ...rest } = options;
  mark(`${label} started`);
  const provider = new CodexProvider(recordingSpawner);
  for await (const chunk of provider.sendQuery(PROMPT, repo, resumeSessionId, {
    // Empty Archon-supplied credentials keep an operator's own from logging the stub in.
    env: {
      CODEX_HOME: home,
      [CODEX_CREDENTIAL_ENV.apiKey]: '',
      [CODEX_CREDENTIAL_ENV.chatgptAccessToken]: '',
      [CODEX_CREDENTIAL_ENV.chatgptAccountId]: '',
      ...env,
    },
    abortSignal,
    ...rest,
  })) {
    mark(`${label} ${chunk.type}`);
    chunks.push(chunk);
  }
  return chunks;
}

function resultOf(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'result' }> {
  const result = chunks.find(c => c.type === 'result');
  if (result?.type !== 'result') throw new Error('no result chunk');
  return result;
}

/** The rollout file Codex writes for `threadId` under the fixture home. */
async function rolloutOf(threadId: string): Promise<string> {
  for await (const path of new Bun.Glob('sessions/**/*.jsonl').scan(home)) {
    if (path.endsWith(`${threadId}.jsonl`)) return join(home, path);
  }
  throw new Error(`no rollout for thread ${threadId}`);
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
  const request = modelRequests[0].body;
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

/** An unsigned ChatGPT access token: Codex reads its claims and never verifies it. */
function chatgptAccessToken(accountId: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'boundary@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' },
  };
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

const MANAGED_TOKEN = chatgptAccessToken('acct-boundary');
const MANAGED_ENV = {
  [CODEX_CREDENTIAL_ENV.chatgptAccessToken]: MANAGED_TOKEN,
  [CODEX_CREDENTIAL_ENV.chatgptAccountId]: 'acct-boundary',
};

interface AuthPath {
  name: string;
  env: Record<string, string>;
  authorization: string | null;
  accountId: string | null;
}
const AUTH_PATHS: AuthPath[] = [
  { name: 'ambient login', env: {}, authorization: null, accountId: null },
  {
    name: 'Archon-supplied API key',
    env: { [CODEX_CREDENTIAL_ENV.apiKey]: 'sk-boundary-key' },
    authorization: 'Bearer sk-boundary-key',
    accountId: null,
  },
  {
    name: 'Archon-managed ChatGPT subscription',
    env: MANAGED_ENV,
    authorization: `Bearer ${MANAGED_TOKEN}`,
    accountId: 'acct-boundary',
  },
];

describe('Codex capability scope on the real binary', () => {
  test.each(AUTH_PATHS)(
    '$name: chat tools round-trip and survive resume with native guidance',
    async ({ env, authorization, accountId }) => {
      const before = await userFileHashes();
      const prompt = 'Fix the "login" bug and add tests';
      let responses = 0;
      modelReply = () => {
        const index = responses++;
        const item =
          index % 2 === 0
            ? {
                type: 'function_call',
                id: `fc_${String(index)}`,
                call_id: `call_${String(index)}`,
                name: 'invoke_workflow',
                arguments: JSON.stringify({ prompt }),
              }
            : {
                type: 'message',
                id: `msg_${String(index)}`,
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Queued.', annotations: [] }],
              };
        const events = [
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: `resp_${String(index)}`,
              status: 'completed',
              output: [item],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          },
        ];
        return new Response(
          events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      };
      const calls: Record<string, unknown>[] = [];
      const nativeTools = [
        {
          name: 'invoke_workflow',
          description: 'Launch the workflow',
          inputSchema: {
            properties: { prompt: { kind: 'string' as const } },
            required: ['prompt'],
          },
          handler: async (input: Record<string, unknown>) => {
            calls.push(input);
            return `queued-${String(calls.length)}`;
          },
        },
      ];
      const chunks = await runRequest({ nativeTools, env });
      const first = resultOf(chunks);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'tool_call',
          name: 'invoke_workflow',
          rawInput: { prompt },
        })
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'tool_call_update',
          status: 'completed',
          output: 'queued-1',
        })
      );
      expect(first.isError).not.toBe(true);
      expect(first.sessionId).toBeDefined();
      expect(calls).toEqual([{ prompt }]);
      expect(modelRequests[0].body).toContain('invoke_workflow');
      expect(modelRequests[0].body).toContain('USER-GUIDANCE-MARKER');
      expect(modelRequests[0].body).toContain('PROJECT-GUIDANCE-MARKER');
      expect(modelRequests[0].body).toContain('AMBIENT-CATALOGUE-MARKER');
      expect(modelRequests[1].body).toContain('queued-1');
      const resumed = resultOf(await runRequest({ nativeTools, env }, first.sessionId));
      expect(resumed.isError).not.toBe(true);
      expect(resumed.sessionId).toBe(first.sessionId);
      expect(calls).toEqual([{ prompt }, { prompt }]);
      expect(modelRequests[3].body).toContain('queued-2');
      for (const request of modelRequests) {
        expect(request).toMatchObject({ authorization, accountId });
      }
      const threadId = first.sessionId?.split(':')[0];
      if (!threadId) throw new Error('thread missing');
      expect(await rolloutOf(threadId)).toStartWith(home);
      expect(await Bun.file(join(home, 'auth.json')).exists()).toBe(false);
      expect(await userFileHashes()).toEqual(before);
    },
    testTimeout(20_000)
  );

  test(
    'a title keeps native guidance and hooks but has no ambient capabilities and a read-only rollout',
    async () => {
      expect(unscopedRequest).toContain('AMBIENT-CATALOGUE-MARKER');
      const result = resultOf(await runRequest({ purpose: 'title-generation' }));
      expect(result.failure?.evidence).toContain('stub model');
      expect(await seen()).toEqual({ tools: [], skills: [], hooks: ['user'], guidance: true });
      expect(modelRequests[0].body).not.toContain('AMBIENT-CATALOGUE-MARKER');
      expect(modelRequests[0].body).not.toContain('AMBIENT-BODY-MARKER');
      expect(modelRequests[0].body).not.toContain('## Skills');
      expect(modelRequests[0].body).not.toContain('# Apps');
      expect(modelRequests[0].body).not.toContain('# Plugins');
      if (!result.sessionId) throw new Error('title thread missing');
      const entries: unknown[] = (await readFile(await rolloutOf(result.sessionId), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as unknown);
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'turn_context',
          payload: expect.objectContaining({
            sandbox_policy: { type: 'read-only' },
            approval_policy: 'never',
          }),
        })
      );
    },
    testTimeout(20_000)
  );

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
    'a forked thread is a new thread that keeps a named plugin’s scope',
    async () => {
      const source = resultOf(await runNode({ plugins: ['alpha@fixture'] })).sessionId;
      expect(source).toBeDefined();
      modelRequests = [];
      await rm(hookLog, { force: true });
      const fork = resultOf(await runNode({ plugins: ['alpha@fixture'] }, source, true));
      expect(fork).toMatchObject({ resumed: true, sessionId: expect.any(String) });
      expect(fork.sessionId).not.toBe(source);
      // A fork that drops the thread config loads the user's server and both plugins again.
      expect(await seen()).toEqual(ALPHA_ONLY);
    },
    testTimeout(20_000)
  );

  test(
    'two runs continuing one thread at once each get their own fork and leave it unchanged',
    async () => {
      const source = resultOf(await runNode({})).sessionId;
      if (!source) throw new Error('source thread missing');
      const rollout = await rolloutOf(source);
      const before = await readFile(rollout, 'utf8');
      const forks = await Promise.all([runNode({}, source, true), runNode({}, source, true)]);
      const ids = forks.map(chunks => resultOf(chunks).sessionId);
      expect(new Set([source, ...ids]).size).toBe(3);
      expect(await readFile(rollout, 'utf8')).toBe(before);
    },
    testTimeout(20_000)
  );

  test(
    'a named plugin loads even when the user turned plugins off globally',
    async () => {
      await addUserConfig('[features]\nplugins = false');
      await runNode({ plugins: ['alpha@fixture'] });
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
    'a declared server that fails to start fails the node before a model request',
    async () => {
      await writeFile(
        join(repo, 'broken-mcp.json'),
        JSON.stringify({ broken_srv: { command: join(root, 'no-such-command') } })
      );
      const chunks = await runNode({ mcp: 'broken-mcp.json' });
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: 'mcp_server_status',
          server: 'broken_srv',
          status: 'failed',
        })
      );
      expect(modelRequests).toHaveLength(0);
      expect(resultOf(chunks).failure).toEqual({
        class: 'misconfigured',
        evidence: expect.stringContaining('broken_srv'),
      });
    },
    testTimeout(20_000)
  );

  test(
    'a model listed as tool-free for structured output gets its tools first, then a tool-free schema request with the evidence',
    async () => {
      const [work, final] = await runToolFreeStructuredNode();
      expect(work.tools.length).toBeGreaterThan(0);
      expect(final.tools).toEqual([]);
    },
    testTimeout(20_000)
  );

  test.each([
    {
      toolMode: 'code_mode_only',
      added: ['exec', 'wait', 'request_user_input_async', 'clock.sleep'],
    },
    { toolMode: 'direct', added: ['request_user_input_async', 'clock.sleep', 'apply_patch'] },
  ])(
    'the tool-free schema request drops the tools a $toolMode catalog entry adds, and the tool turn keeps them',
    async ({ toolMode, added }) => {
      await addUserCatalog({ ...CATALOG_TOOLS, tool_mode: toolMode });
      const [work, final] = await runToolFreeStructuredNode();
      expect(work.tools).toEqual(expect.arrayContaining(added));
      expect(final.tools).toEqual([]);
    },
    testTimeout(20_000)
  );

  test(
    'a catalog entry with multi-agent v2 keeps exactly its collaboration tools on the schema request',
    async () => {
      await addUserCatalog({ ...CATALOG_TOOLS, multi_agent_version: 'v2' });
      const [work, final] = await runToolFreeStructuredNode();
      expect(work.tools).toEqual(expect.arrayContaining(['exec', 'wait', ...COLLABORATION]));
      expect(final.tools).toEqual(COLLABORATION);
    },
    testTimeout(20_000)
  );

  // The final turn's process does not load the user's catalog entry, so it must still
  // compact by that entry's context window, not by Codex's fallback window.
  test.each([
    { contextWindow: 10_000, inputTokens: 9_000, requests: 3 },
    { contextWindow: 1_000_000, inputTokens: 300_000, requests: 2 },
  ])(
    'the schema turn compacts by the tool turn’s context window: $inputTokens of $contextWindow tokens sends $requests requests',
    async ({ contextWindow, inputTokens, requests }) => {
      await addUserCatalog({ ...CATALOG_TOOLS, context_window: contextWindow });
      const result = await runSplitCall(inputTokens);
      expect(result.structuredOutput).toEqual(ANSWER);
      expect(modelRequests).toHaveLength(requests);
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

/** The tools a model request carries, top-level and in `additional_tools` input items. */
function requestTools(body: string): string[] {
  interface Tool {
    type: string;
    name?: string;
    tools?: Tool[];
  }
  const request = JSON.parse(body) as {
    tools?: Tool[];
    input?: { type: string; tools?: Tool[] }[];
  };
  const listed = [
    ...(request.tools ?? []),
    ...(request.input ?? []).flatMap(item =>
      item.type === 'additional_tools' ? (item.tools ?? []) : []
    ),
  ];
  return listed.flatMap(tool =>
    tool.tools
      ? tool.tools.map(inner => `${tool.name ?? tool.type}.${inner.name ?? inner.type}`)
      : [tool.name ?? tool.type]
  );
}

/** A model request's tools and output format, and whether it carries the tool turn's evidence. */
interface SplitRequest {
  tools: string[];
  format: unknown;
  evidence: boolean;
}

const ANSWER = { summary: 'done' };

/**
 * Runs an `output_format` node on a model listed in `toolFreeStructuredOutputModels`: the
 * stub answers the tool turn with a marker and every later request with the JSON answer,
 * each reporting `inputTokens` used.
 */
async function runSplitCall(
  inputTokens: number
): Promise<Extract<MessageChunk, { type: 'result' }>> {
  let responses = 0;
  modelReply = () => {
    const index = responses++;
    const text = index === 0 ? 'REVIEW-FINDING-MARKER' : JSON.stringify(ANSWER);
    const item = {
      type: 'message',
      id: `msg_${String(index)}`,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    const events = [
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: `resp_${String(index)}`,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: inputTokens,
            output_tokens: 5,
            total_tokens: inputTokens + 5,
          },
        },
      },
    ];
    return new Response(
      events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    );
  };
  return resultOf(
    await runRequest({
      assistantConfig: { model: 'stub-model', toolFreeStructuredOutputModels: ['stub-model'] },
      nodeConfig: {
        nodeId: 'review',
        output_format: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    })
  );
}

/** `runSplitCall` with little context used. Asserts the call's shape and returns its two model requests. */
async function runToolFreeStructuredNode(): Promise<SplitRequest[]> {
  const result = await runSplitCall(10);
  expect(result.failure).toBeUndefined();
  expect(result.structuredOutput).toEqual(ANSWER);
  const requests = modelRequests.map(({ body }) => ({
    tools: requestTools(body),
    format: (JSON.parse(body) as { text?: { format?: unknown } }).text?.format,
    evidence: body.includes('REVIEW-FINDING-MARKER'),
  }));
  expect(requests).toHaveLength(2);
  expect(requests[0].format).toBeUndefined();
  expect(requests[1].format).toMatchObject({ type: 'json_schema' });
  expect(requests[1].evidence).toBe(true);
  return requests;
}

/**
 * A user catalog entry for the stub model whose direct tool settings add tools: code mode's
 * `exec` and `wait`, the async input tool and `clock`, and `apply_patch` outside code mode.
 */
const CATALOG_TOOLS = {
  slug: 'stub-model',
  display_name: 'stub-model',
  supported_reasoning_levels: [],
  shell_type: 'unified_exec',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  base_instructions: '',
  tool_mode: 'code_mode_only',
  experimental_supported_tools: ['send_user_message_async', 'clock'],
  apply_patch_tool_type: 'freeform',
};

/** The tools a `multi_agent_version: v2` catalog entry adds, which persist with the thread. */
const COLLABORATION = [
  'collaboration.followup_task',
  'collaboration.interrupt_agent',
  'collaboration.list_agents',
  'collaboration.send_message',
  'collaboration.spawn_agent',
  'collaboration.wait_agent',
];

/** Points this test's `model_catalog_json` at a one-entry catalog. */
async function addUserCatalog(entry: object): Promise<void> {
  const catalogPath = join(home, 'user-catalog.json');
  await writeFile(catalogPath, JSON.stringify({ models: [entry] }));
  await addUserConfig(`model_catalog_json = ${toml(catalogPath)}`, 'prepend');
}

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(await readFile(path)).digest('hex');
}

/** The user's config and guidance files, hashed, so a run that rewrote one shows. */
async function userFileHashes(): Promise<string[]> {
  const files = [
    join(home, 'config.toml'),
    join(home, 'AGENTS.md'),
    join(home, 'hooks.json'),
    join(repo, 'AGENTS.md'),
  ];
  return await Promise.all(files.map(sha256));
}

async function runAuthedNode(
  env: Record<string, string>,
  nodeConfig: SendQueryOptions['nodeConfig'] = {}
): Promise<MessageChunk[]> {
  return await runRequest({ nodeConfig: { nodeId: 'scoped', ...nodeConfig }, env });
}

describe('Codex auth paths keep the user’s own home on the real binary', () => {
  test.each(AUTH_PATHS)(
    '$name authenticates with the user’s config and guidance and writes nothing to their home',
    async ({ env, authorization, accountId }) => {
      const before = await userFileHashes();
      const result = resultOf(await runAuthedNode(env));
      expect(result.failure?.evidence).toContain('stub model');
      // The user's config.toml defined the provider that received this credential.
      expect(modelRequests[0]).toMatchObject({ authorization, accountId });
      expect((await seen()).guidance).toBe(true);
      if (!result.sessionId) throw new Error('thread missing');
      expect(await rolloutOf(result.sessionId)).toStartWith(home);
      expect(await Bun.file(join(home, 'auth.json')).exists()).toBe(false);
      expect(await userFileHashes()).toEqual(before);
    },
    testTimeout(20_000)
  );

  test(
    'a managed subscription leaves capability scope as it is',
    async () => {
      await runAuthedNode(MANAGED_ENV);
      expect(modelRequests[0].authorization).toBe(`Bearer ${MANAGED_TOKEN}`);
      expect(await seen()).toEqual({ tools: [], skills: [], hooks: ['user'], guidance: true });

      modelRequests = [];
      await rm(hookLog, { force: true });
      await runAuthedNode(MANAGED_ENV, { plugins: ['alpha@fixture'] });
      expect(modelRequests[0].authorization).toBe(`Bearer ${MANAGED_TOKEN}`);
      expect(await seen()).toEqual(ALPHA_ONLY);
    },
    testTimeout(40_000)
  );
});

describe('a test that ends with a run in flight', () => {
  let left: Promise<string> | undefined;

  test('edits its config and leaves its turn waiting on the model', async () => {
    await addUserCatalog(CATALOG_TOOLS);
    const asked = Promise.withResolvers<undefined>();
    modelReply = () => {
      asked.resolve(undefined);
      return new Promise<Response>(() => undefined);
    };
    left = runRequest({}).then(
      () => 'finished',
      (error: unknown) => String(error)
    );
    await asked.promise;
  });

  test('leaves the next test the template config and no run still talking to the stub', async () => {
    expect(await settlesWithin(left ?? Promise.resolve(), 0)).toBe(true);
    expect(await left).toContain('Query aborted');
    const [fresh, original] = await Promise.all(
      [home, template].map(dir => readFile(join(dir, 'config.toml'), 'utf8'))
    );
    expect(fresh).toBe(trustCopiedUserHook(original, home));
    expect(modelRequests).toEqual([]);
  });
});
