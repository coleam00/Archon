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
