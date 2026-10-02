import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { IWorkflowPlatform } from './deps';
import {
  createAttemptEventSequence,
  createProviderEventHandler,
  type AttemptEventSequence,
} from './provider-events';
import { providerEventEnvelopeSchema } from './schemas/provider-event';
import type { IWorkflowStore } from './store';

const trackTempRoot = trackTempRoots();

type CreateEvent = IWorkflowStore['createWorkflowEvent'];

async function makeHandler(
  options: { configuredMcpServers?: string[]; attempt?: AttemptEventSequence } = {}
): Promise<{
  handler: ReturnType<typeof createProviderEventHandler>;
  rows: Parameters<CreateEvent>[0][];
  sent: string[];
}> {
  const rows: Parameters<CreateEvent>[0][] = [];
  const sent: string[] = [];
  const platform: IWorkflowPlatform = {
    sendMessage: mock(async (_conversationId: string, message: string) => {
      sent.push(message);
    }),
    getStreamingMode: () => 'batch',
    getPlatformType: () => 'test',
  };
  const handler = createProviderEventHandler({
    store: {
      createWorkflowEvent: mock(async (event: Parameters<CreateEvent>[0]) => {
        rows.push(event);
      }),
    },
    platform,
    conversationId: 'conv-1',
    messageContext: {},
    logDir: trackTempRoot(await mkdtemp(join(tmpdir(), 'provider-events-'))),
    runId: 'run-1',
    nodeId: 'node-1',
    stepName: 'node-1',
    attempt: options.attempt ?? createAttemptEventSequence('attempt-1'),
    configuredMcpServers: new Set(options.configuredMcpServers),
    onMessageText: async () => undefined,
  });
  return { handler, rows, sent };
}

describe('createProviderEventHandler', () => {
  test('tracks a subtask from its start until a terminal status', async () => {
    const { handler } = await makeHandler();

    await handler.handle({ type: 'subtask', taskId: 't-1', status: 'started' });
    await handler.handle({ type: 'subtask', taskId: 't-2', status: 'started' });
    await handler.handle({ type: 'subtask', taskId: 't-1', status: 'running' });
    expect(handler.liveSubtaskIds()).toEqual(['t-1', 't-2']);

    await handler.handle({ type: 'subtask', taskId: 't-1', status: 'completed' });
    await handler.handle({ type: 'subtask', taskId: 't-2', status: 'stopped' });
    expect(handler.liveSubtaskIds()).toEqual([]);
  });

  test('records only what the provider reported, with no engine-made completion', async () => {
    const { handler, rows } = await makeHandler();

    await handler.handle({ type: 'tool_call', toolCallId: 'a', name: 'Read' });
    await handler.handle({ type: 'tool_call', toolCallId: 'b', name: 'Read' });
    await handler.handle({ type: 'tool_call_update', toolCallId: 'b', status: 'cancelled' });
    await handler.handle({ type: 'agent_message_chunk', text: 'done' });

    // Tool `a` never closed: nothing records an `unknown` completion for it.
    expect(rows.map(row => providerEventEnvelopeSchema.parse(row.data).event)).toEqual([
      { type: 'tool_call', toolCallId: 'a', name: 'Read' },
      { type: 'tool_call', toolCallId: 'b', name: 'Read' },
      { type: 'tool_call_update', toolCallId: 'b', status: 'cancelled' },
      { type: 'agent_message_chunk', text: 'done' },
    ]);
  });

  test('a second stream pass of one attempt numbers on from the first', async () => {
    const attempt = createAttemptEventSequence('attempt-9');
    const first = await makeHandler({ attempt });
    const reask = await makeHandler({ attempt });
    await first.handler.handle({ type: 'agent_message_chunk', text: 'one' });
    await first.handler.handle({ type: 'agent_message_chunk', text: 'two' });
    await reask.handler.handle({ type: 'agent_message_chunk', text: 'three' });

    expect(
      [...first.rows, ...reask.rows].map(row => {
        const { attemptId, seq } = providerEventEnvelopeSchema.parse(row.data);
        return [attemptId, seq];
      })
    ).toEqual([
      ['attempt-9', 0],
      ['attempt-9', 1],
      ['attempt-9', 2],
    ]);
  });

  test('sends a warning to the platform with a ⚠️ prefix', async () => {
    const { handler, sent } = await makeHandler();

    await handler.handle({
      type: 'warning',
      code: 'pi.extension_notify',
      message: 'Open the link',
    });

    expect(sent).toEqual(['⚠️ Open the link']);
  });

  test('surfaces a failed MCP server only when the node configured it', async () => {
    const { handler, sent } = await makeHandler({ configuredMcpServers: ['github'] });

    await handler.handle({ type: 'mcp_server_status', server: 'plugin-mcp', status: 'failed' });
    await handler.handle({
      type: 'mcp_server_status',
      server: 'github',
      status: 'needs_auth',
      error: 'token expired',
    });

    expect(sent).toEqual(['MCP server connection failed: github (needs_auth): token expired']);
  });
});
