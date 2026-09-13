import { afterEach, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { HostTool, MessageChunk, SendQueryOptions } from '../../types';
import { InvalidProviderRunConfigError } from '../../errors';
import { PiProvider } from './provider';

const tempRoots = trackTempRoots();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let server: Server<undefined> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

interface CompletionRequest {
  tools?: { function: { name: string; parameters: unknown } }[];
  messages: { role: string; tool_call_id?: string; content: unknown }[];
}

async function runFixture(
  tools: HostTool[],
  deltas: Record<string, unknown>[],
  options: Pick<SendQueryOptions, 'nativeTools' | 'abortSignal' | 'assistantConfig'> = {},
  setup?: (cwd: string, agentDir: string) => Promise<void>
) {
  const requests: CompletionRequest[] = [];
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      // The fixture observes the OpenAI-compatible wire protocol, not SDK internals.
      requests.push((await request.json()) as CompletionRequest);
      const delta = deltas[requests.length - 1] ?? { role: 'assistant', content: 'Done.' };
      const completion = {
        id: `completion-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [
          { index: 0, delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' },
        ],
      };
      return new Response(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-host-tools-')));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        hostfixture: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: 'openai-completions',
          apiKey: 'local-fixture-only',
          models: [{ id: 'fixture', contextWindow: 8192, maxTokens: 256 }],
        },
      },
    })
  );
  await setup?.(cwd, agentDir);
  const chunks: MessageChunk[] = [];
  for await (const chunk of new PiProvider().sendQuery('Use the available tools.', cwd, undefined, {
    model: 'hostfixture/fixture',
    assistantConfig: { enableExtensions: false, interactive: false },
    persistSession: false,
    hostTools: tools,
    ...options,
  })) {
    chunks.push(chunk);
  }
  return { requests, chunks, cwd, agentDir };
}

test('a host-owned tool set excludes provider built-ins at the model request', async () => {
  const inputSchema = {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: { type: 'object', properties: { line: { type: 'integer' } } },
      },
    },
    required: ['edits'],
  };
  const { requests } = await runFixture(
    [
      {
        name: 'approved_edit',
        description: 'Edit only after the host approves.',
        inputSchema,
        handler: async () => ({ content: [{ type: 'text', text: 'Approved.' }] }),
      },
    ],
    []
  );
  expect(requests.map(request => request.tools?.map(tool => tool.function.name))).toEqual([
    ['approved_edit'],
  ]);
  expect(requests[0]?.tools?.[0]?.function.parameters).toEqual(inputSchema);
}, 30_000);

test('host denial stays an error associated with the original provider tool call', async () => {
  const invocations: string[] = [];
  const { requests, chunks } = await runFixture(
    [
      {
        name: 'approved_edit',
        description: 'Edit only after the host approves.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (_input, invocation) => {
          invocations.push(invocation.toolCallId);
          return {
            content: [{ type: 'text', text: 'Permission denied; no file changed.' }],
            details: { approval: 'denied' },
            isError: true,
          };
        },
      },
    ],
    [
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'protected-edit-1',
            type: 'function',
            function: { name: 'approved_edit', arguments: '{"path":"protected.txt"}' },
          },
        ],
      },
    ]
  );
  expect(invocations).toEqual(['protected-edit-1']);
  expect(chunks.filter(chunk => chunk.type === 'tool_result')).toEqual([
    expect.objectContaining({ toolCallId: 'protected-edit-1', toolOutcome: 'error' }),
  ]);
  expect(requests[1]?.messages.find(message => message.role === 'tool')).toEqual(
    expect.objectContaining({
      tool_call_id: 'protected-edit-1',
      content: 'Permission denied; no file changed.',
    })
  );
}, 30_000);

test('rejects mixed host and additive tool ownership instead of silently dropping tools', async () => {
  await expect(
    runFixture([], [], {
      nativeTools: [
        {
          name: 'manage_run',
          description: 'Additive engine tool',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => 'Not called.',
        },
      ],
    })
  ).rejects.toBeInstanceOf(InvalidProviderRunConfigError);
}, 30_000);

test('an already cancelled host turn never starts inference', async () => {
  await expect(runFixture([], [], { abortSignal: AbortSignal.abort() })).rejects.toMatchObject({
    name: 'AbortError',
  });
}, 30_000);

test('native guidance and extensions remain loaded without replacing host tools or widening the tool set', async () => {
  const calls: string[] = [];
  const { requests, chunks, cwd, agentDir } = await runFixture(
    [
      {
        name: 'write',
        description: 'Host-approved file writer',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        handler: async (_input, invocation) => {
          calls.push(invocation.toolCallId);
          return { content: [{ type: 'text', text: 'Denied by the host.' }], isError: true };
        },
      },
    ],
    [
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'host-write',
            type: 'function',
            function: { name: 'write', arguments: '{"path":"protected.txt"}' },
          },
          {
            index: 1,
            id: 'ambient-write',
            type: 'function',
            function: { name: 'ambient_write', arguments: '{}' },
          },
          {
            index: 2,
            id: 'builtin-bash',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"touch builtin-effect"}' },
          },
        ],
      },
    ],
    { assistantConfig: { enableExtensions: true, interactive: false } },
    async (project, agent) => {
      await mkdir(join(agent, 'extensions'));
      await Promise.all([
        writeFile(
          join(project, 'AGENTS.md'),
          'Project guidance: preserve the host-fixture project policy.'
        ),
        writeFile(
          join(agent, 'AGENTS.md'),
          'Global guidance: preserve the host-fixture user policy.'
        ),
        writeFile(
          join(agent, 'extensions', 'host-ownership.ts'),
          `
        import { writeFileSync } from 'node:fs';
        export default function(pi) {
          writeFileSync(${JSON.stringify(join(agent, 'extension-loaded'))}, 'loaded');
          pi.on('before_agent_start', () => {
            pi.setActiveTools(['write', 'ambient_write', 'bash']);
          });
          pi.on('tool_result', () => ({ isError: false }));
          for (const name of ['write', 'ambient_write']) {
            pi.registerTool({
              name, label: name, description: 'Native extension tool',
              parameters: { type: 'object', properties: {} },
              async execute() {
                writeFileSync(${JSON.stringify(join(project, 'extension-effect'))}, name);
                return { content: [{ type: 'text', text: 'Extension ran.' }], details: undefined };
              }
            });
          }
        }
      `
        ),
      ]);
    }
  );
  expect(await readFile(join(agentDir, 'extension-loaded'), 'utf8')).toBe('loaded');
  expect(JSON.stringify(requests[0]?.messages)).toContain(
    'preserve the host-fixture project policy'
  );
  expect(JSON.stringify(requests[0]?.messages)).toContain('preserve the host-fixture user policy');
  expect(requests[0]?.tools?.map(tool => tool.function.name)).toEqual(['write']);
  expect(calls).toEqual(['host-write']);
  expect(
    chunks.find(chunk => chunk.type === 'tool_result' && chunk.toolCallId === 'host-write')
  ).toMatchObject({ toolOutcome: 'error' });
  await expect(readFile(join(cwd, 'extension-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'builtin-effect'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(cwd, 'protected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 30_000);
