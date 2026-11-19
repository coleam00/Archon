import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree, testTimeout } from '@archon/paths/test-utils';
import type { MessageChunk } from '../types';
import { ClaudeProvider } from './provider';
import { resolveBundledClaudeBinary } from './plugins';

const MCP_STUB = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize'
    ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'delayed', version: '1' } }
    : m.method === 'tools/list' ? { tools: [] } : {};
  const reply = () => {
    if (!require('node:fs').existsSync(process.argv[2])) { setTimeout(reply, 10); return; }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  };
  reply();
});
`;

test(
  'JSON Schema tools keep their schema and validate calls through the Claude Agent SDK',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-native-tool-'));
    const calls: unknown[] = [];
    const advertised: unknown[] = [];
    let requested = 0;
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
      additionalProperties: false,
    };
    const model = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith('/messages'))
          return new Response(null, { status: 404 });
        const body = (await request.json()) as {
          model: string;
          tools?: { name: string; input_schema: unknown }[];
        };
        const tool = body.tools?.find(item => item.name === 'mcp__archon__lookup');
        advertised.push(tool?.input_schema);
        const index = requested++;
        const input = index === 0 ? {} : { count: 7 };
        const block =
          index < 2
            ? { type: 'tool_use', id: `toolu_fixture_${index}`, name: 'mcp__archon__lookup', input }
            : { type: 'text', text: 'Done' };
        const stop = index < 2 ? 'tool_use' : 'end_turn';
        const usage = { input_tokens: 10, output_tokens: 2 };
        const events = [
          {
            type: 'message_start',
            message: {
              id: `msg_fixture_${index}`,
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage,
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block:
              block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta:
              block.type === 'tool_use'
                ? { type: 'input_json_delta', partial_json: JSON.stringify(input) }
                : { type: 'text_delta', text: block.text },
          },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage },
          { type: 'message_stop' },
        ];
        return new Response(
          events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          }
        );
      },
    });
    try {
      const binary = resolveBundledClaudeBinary();
      if (!binary) throw new Error('Missing bundled Claude');
      const chunks = await Array.fromAsync(
        new ClaudeProvider().sendQuery('Use lookup.', root, undefined, {
          nativeTools: [
            {
              name: 'lookup',
              description: 'Look up an item',
              inputSchema: { jsonSchema: schema },
              handler: async (input, context) => {
                calls.push({ input, context });
                return 'ok';
              },
            },
          ],
          abortSignal: AbortSignal.timeout(20_000),
          model: 'claude-sonnet-4-6',
          nodeConfig: { nodeId: 'lookup', settingSources: [] },
          assistantConfig: { claudeBinaryPath: binary },
          env: {
            CLAUDE_CONFIG_DIR: root,
            ANTHROPIC_API_KEY: 'local-fixture',
            CLAUDE_CODE_OAUTH_TOKEN: '',
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_BASE_URL: model.url.toString(),
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDECODE: '',
          },
        })
      );
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'result', text: 'Done' }));
      expect(requested).toBe(3);
      expect(advertised[0]).toMatchObject(schema);
      expect(calls).toEqual([
        {
          input: { count: 7 },
          context: { providerCallId: expect.any(String), providerCallScope: expect.any(String) },
        },
      ]);
    } finally {
      await model.stop(true);
      await removeTempTree(root);
    }
  },
  testTimeout(30_000)
);

for (const mode of ['broken', 'delayed', 'collision'] as const) {
  const broken = mode !== 'delayed';
  const collision = mode === 'collision';
  const name = collision ? 'archon' : 'declared';
  test(
    `native Claude MCP admission: ${mode}`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-mcp-boundary-'));
      let modelCalls = 0;
      let modelCalledBeforeConnected = false;
      const observations: MessageChunk[] = [];
      const model = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname.endsWith('/messages')) {
            modelCalls++;
            // An expect here would only fail the fixture's response, not the test.
            if (
              !observations.some(
                c => c.type === 'mcp_server_status' && c.server === name && c.status === 'connected'
              )
            )
              modelCalledBeforeConnected = true;
          }
          return Response.json(
            { error: { type: 'invalid_request_error', message: 'local fixture' } },
            { status: 400 }
          );
        },
      });
      try {
        const binary = resolveBundledClaudeBinary();
        if (!binary) throw new Error('Missing bundled Claude');
        const stub = join(root, 'mcp.cjs');
        await writeFile(stub, MCP_STUB);
        const mcp = join(root, 'servers.json');
        const release = join(root, 'release');
        await writeFile(
          mcp,
          JSON.stringify({
            [name]: broken
              ? { command: join(root, 'missing-executable') }
              : { command: process.execPath, args: [stub, release] },
          })
        );
        for await (const chunk of new ClaudeProvider().sendQuery(
          'Reply with OK.',
          root,
          undefined,
          {
            ...(collision
              ? {
                  nativeTools: [
                    {
                      name: 'inspect',
                      description: 'Inspect',
                      inputSchema: { properties: {}, required: [] },
                      handler: async () => 'unused',
                    },
                  ],
                }
              : {}),
            abortSignal: AbortSignal.timeout(20_000),
            model: 'claude-sonnet-4-6',
            nodeConfig: { nodeId: 'readiness', mcp, settingSources: [] },
            assistantConfig: { claudeBinaryPath: binary },
            env: {
              CLAUDE_CONFIG_DIR: root,
              ANTHROPIC_API_KEY: 'local-fixture',
              CLAUDE_CODE_OAUTH_TOKEN: '',
              ANTHROPIC_AUTH_TOKEN: '',
              ANTHROPIC_BASE_URL: model.url.toString(),
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
              CLAUDECODE: '',
            },
          }
        )) {
          observations.push(chunk);
          if (chunk.type === 'mcp_server_status' && chunk.status === 'pending')
            await writeFile(release, 'ready');
        }
        expect(modelCalledBeforeConnected).toBe(false);
        if (broken) {
          expect(modelCalls).toBe(0);
          expect(observations).toContainEqual(
            expect.objectContaining({
              type: 'result',
              failure: {
                class: 'misconfigured',
                evidence: expect.stringContaining(name),
              },
            })
          );
        } else {
          expect(modelCalls).toBeGreaterThan(0);
          const pending = observations.findIndex(
            c => c.type === 'mcp_server_status' && c.status === 'pending'
          );
          const connected = observations.findIndex(
            c => c.type === 'mcp_server_status' && c.status === 'connected'
          );
          expect(pending).toBeGreaterThanOrEqual(0);
          expect(connected).toBeGreaterThan(pending);
        }
      } finally {
        await model.stop(true);
        await removeTempTree(root);
      }
    },
    testTimeout(30_000)
  );
}
