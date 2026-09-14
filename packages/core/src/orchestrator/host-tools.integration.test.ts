import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import type { HostTool, HostToolResult, MessageChunk } from '@archon/providers/types';
import type { IPlatformAdapter } from '../types';

// Isolated test group: the real core database, configuration and SDK own process state.
test('host-owned stream and batch turns preserve approvals, results and presentation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-host-tools-'));
  const ownedEnv = {
    HOME: join(root, 'user'),
    ARCHON_HOME: join(root, 'engine'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    DEFAULT_AI_ASSISTANT: 'pi',
  };
  const previousEnv = Object.fromEntries(Object.keys(ownedEnv).map(key => [key, process.env[key]]));
  Object.assign(process.env, ownedEnv);
  try {
    await mkdir(ownedEnv.HOME);
    const { handleMessage, codebaseDb, conversationDb, closeDatabase } = await import('../index');
    const { registerBuiltinProviders, registerCommunityProviders } =
      await import('@archon/providers');
    const home = join(root, 'engine');
    const agentDir = join(root, 'pi');
    const project = join(root, 'project');
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
      mkdir(join(project, '.archon'), { recursive: true }),
    ]);
    const protectedPath = join(project, 'protected.txt');
    const image: HostToolResult['content'][number] = {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBnkAAAAASUVORK5CYII=',
      mimeType: 'image/png',
    };
    let requests = 0;
    const wireTools: string[][] = [];
    const toolCall = (id: string, path: string) => ({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path, lines: ['approved'] }) },
        },
      ],
    });
    interface WireRequest {
      tools?: { function: { name: string } }[];
    }
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        const body = (await request.json()) as WireRequest;
        wireTools.push(body.tools?.map(tool => tool.function.name) ?? []);
        requests++;
        const delta =
          requests === 1
            ? toolCall('deny-1', protectedPath)
            : requests === 2
              ? toolCall('allow-1', protectedPath)
              : requests === 3
                ? { role: 'assistant', content: `/register-project Unapproved ${project}` }
                : requests === 4
                  ? toolCall('unavailable-2', protectedPath)
                  : requests === 5
                    ? { role: 'assistant', content: 'Second turn complete.' }
                    : requests === 6
                      ? toolCall('cancel-3', protectedPath)
                      : { role: 'assistant', content: 'Unexpected extra inference.' };
        const chunk = {
          id: `completion-${requests}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            { index: 0, delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    try {
      await writeFile(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            hostfixture: {
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              api: 'openai-completions',
              apiKey: 'local-fixture-only',
              models: [
                { id: 'fixture', input: ['text', 'image'], contextWindow: 8192, maxTokens: 256 },
              ],
            },
          },
        })
      );
      await writeFile(
        join(home, 'config.yaml'),
        JSON.stringify({
          defaultAssistant: 'pi',
          assistants: {
            pi: { model: 'hostfixture/fixture', enableExtensions: false, interactive: false },
          },
        })
      );
      await writeFile(
        join(project, '.archon', 'config.yaml'),
        JSON.stringify({ tiers: { large: { provider: 'pi', model: 'hostfixture/fixture' } } })
      );
      registerBuiltinProviders();
      registerCommunityProviders();
      const codebase = await codebaseDb.createCodebase({
        name: 'host-smoke',
        default_cwd: project,
        kind: 'folder',
        ai_assistant_type: 'pi',
      });
      // Reuse one initialized core runtime; its configuration and database are process-owned.
      for (const mode of ['batch', 'stream'] as const) {
        const conversationId = `host-smoke-${mode}`;
        requests = 0;
        wireTools.length = 0;
        await writeFile(protectedPath, 'before\n');
        let providerToolText = false;
        const output: string[] = [];
        const events: MessageChunk[] = [];
        const platform: IPlatformAdapter = {
          getPlatformType: () => 'cli',
          getStreamingMode: () => mode,
          ensureThread: async id => id,
          sendMessage: async (_id, content, options) => {
            if (options?.category === 'tool_call_formatted') providerToolText = true;
            output.push(content);
          },
          sendStructuredEvent: async (_id, event) => {
            events.push(event);
          },
          start: async () => {},
          stop: () => {},
        };
        const calls: string[] = [];
        let effects = 0;
        const tool: HostTool = {
          name: 'write',
          description: 'Write after explicit host approval.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              lines: { type: 'array', items: { type: 'string' } },
            },
            required: ['path', 'lines'],
          },
          handler: async (input, invocation) => {
            calls.push(invocation.toolCallId);
            assert.equal(input.path, protectedPath);
            assert.deepEqual(input.lines, ['approved']);
            if (invocation.toolCallId === 'deny-1') {
              assert.equal(await readFile(protectedPath, 'utf8'), 'before\n');
              return {
                content: [{ type: 'text', text: 'Denied.' }],
                details: { approved: false },
                isError: true,
              };
            }
            assert.equal(invocation.toolCallId, 'allow-1');
            invocation.onUpdate?.({
              content: [{ type: 'text', text: 'Applying approved write.' }],
              details: { phase: 'writing' },
              isError: false,
            });
            effects++;
            await writeFile(protectedPath, 'approved\n');
            return {
              content: [{ type: 'text', text: 'Written.' }, image],
              details: { approved: true },
            };
          },
        };
        const conversation = await conversationDb.getOrCreateConversation('cli', conversationId);
        await conversationDb.updateConversation(conversation.id, {
          codebase_id: codebase.id,
          cwd: project,
        });
        await handleMessage(platform, conversationId, '/workflow run host-owned-request', {
          hostTools: [tool],
        });
        assert.deepEqual(calls, ['deny-1', 'allow-1']);
        assert.equal(effects, 1);
        assert.deepEqual(
          events
            .filter(event => event.type === 'tool_update')
            .map(event => ({
              id: event.toolCallId,
              result: event.toolResult,
            })),
          [
            {
              id: 'allow-1',
              result: {
                content: [{ type: 'text', text: 'Applying approved write.' }],
                details: { phase: 'writing' },
                isError: false,
              },
            },
          ]
        );
        assert.deepEqual(
          events
            .filter(event => event.type === 'tool_result')
            .map(event => ({
              id: event.toolCallId,
              text: event.toolOutput,
              result: event.toolResult,
            })),
          [
            {
              id: 'deny-1',
              text: 'Denied.',
              result: {
                content: [{ type: 'text', text: 'Denied.' }],
                details: { approved: false },
                isError: true,
              },
            },
            {
              id: 'allow-1',
              text: 'Written.',
              result: {
                content: [{ type: 'text', text: 'Written.' }, image],
                details: { approved: true },
                isError: false,
              },
            },
          ]
        );
        assert.equal(await readFile(protectedPath, 'utf8'), 'approved\n');
        assert.equal((await codebaseDb.listCodebases()).length, 1);
        assert(output.join('').includes('/register-project Unapproved'));
        await handleMessage(platform, conversationId, 'This turn has no tools.', { hostTools: [] });
        assert.deepEqual(calls, ['deny-1', 'allow-1']);
        assert.equal(await readFile(protectedPath, 'utf8'), 'approved\n');
        assert.deepEqual(wireTools.slice(0, 3), [['write'], ['write'], ['write']]);
        assert.deepEqual(wireTools.slice(3, 5), [[], []]);
        let started: (() => void) | undefined;
        const toolStarted = new Promise<void>(resolve => {
          started = resolve;
        });
        const cancellation = new AbortController();
        let cancellationObserved = false;
        const waitingTool: HostTool = {
          ...tool,
          handler: async (_input, invocation) => {
            assert.equal(invocation.toolCallId, 'cancel-3');
            assert(invocation.signal);
            const signal = invocation.signal;
            await new Promise<void>(resolve => {
              signal.addEventListener(
                'abort',
                () => {
                  cancellationObserved = true;
                  resolve();
                },
                { once: true }
              );
              started?.();
            });
            return {
              content: [{ type: 'text', text: 'Cancelled without writing.' }],
              isError: true,
            };
          },
        };
        const pending = handleMessage(platform, conversationId, 'Wait for host approval.', {
          hostTools: [waitingTool],
          abortSignal: cancellation.signal,
        });
        await Promise.race([
          toolStarted,
          pending.then(() => {
            throw new Error('Turn ended before the host tool was invoked');
          }),
        ]);
        cancellation.abort();
        await pending;
        assert(cancellationObserved);
        assert.equal(await readFile(protectedPath, 'utf8'), 'approved\n');
        assert.equal(requests, 6);
        const outcomes = events
          .filter(event => event.type === 'tool_result')
          .map(event => ({ id: event.toolCallId, outcome: event.toolOutcome }));
        assert.deepEqual(outcomes, [
          { id: 'deny-1', outcome: 'error' },
          { id: 'allow-1', outcome: 'success' },
          { id: 'unavailable-2', outcome: 'error' },
          { id: 'cancel-3', outcome: 'error' },
        ]);
        assert.equal(providerToolText, false);
      }
    } finally {
      server.stop(true);
      await closeDatabase();
    }
  } finally {
    for (const key of Object.keys(ownedEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await removeTempTree(root);
  }
}, 30_000);
