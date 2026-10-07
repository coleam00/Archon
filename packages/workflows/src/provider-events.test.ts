import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { subtaskSchema, subtaskTerminalStatusSchema } from '@archon/provider-contract';
import type { IWorkflowPlatform } from './deps';
import {
  createAttemptEventSequence,
  createProviderEventHandler,
  type AttemptEventSequence,
} from './provider-events';
import { orderProviderEventRecords, providerEventEnvelopeSchema } from './schemas/provider-event';
import orderFixture from './schemas/provider-event-order.fixture.json';
import type { IWorkflowStore } from './store';
import { createToolCallAttention } from './tool-call-attention';

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
    toolAttention: createToolCallAttention({
      store: { setToolCallAttention: mock(async () => true) },
      runId: 'run-1',
      nodeId: 'node-1',
      attemptId: options.attempt?.attemptId ?? 'attempt-1',
      provider: 'test',
      thresholdMs: 0,
      env: {},
    }),
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
  test('typed open tools stay live until their own terminal update', async () => {
    const { handler } = await makeHandler();
    await handler.handle({ type: 'tool_call', toolCallId: 'a', name: 'Bash' });
    await handler.handle({ type: 'tool_call', toolCallId: 'b', name: 'Bash' });
    await handler.handle({ type: 'tool_call_update', toolCallId: 'a', status: 'completed' });
    await handler.handle({ type: 'tool_call_update', toolCallId: 'unknown', status: 'cancelled' });
    expect(handler.hasOpenTools()).toBe(true);
    await handler.handle({ type: 'tool_call_update', toolCallId: 'b', status: 'failed' });
    expect(handler.hasOpenTools()).toBe(false);
  });
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

  test('keeps every contract non-terminal status live and removes only terminal statuses', async () => {
    const { handler } = await makeHandler();
    const terminalStatuses: ReadonlySet<string> = new Set(subtaskTerminalStatusSchema.options);
    for (const status of subtaskSchema.shape.status.options) {
      await handler.handle({ type: 'subtask', taskId: status, status });
      expect(handler.liveSubtaskIds().includes(status)).toBe(!terminalStatuses.has(status));
    }
    for (const status of subtaskTerminalStatusSchema.options) {
      await handler.handle({ type: 'subtask', taskId: 'running', status });
      expect(handler.liveSubtaskIds()).not.toContain('running');
      await handler.handle({ type: 'subtask', taskId: 'running', status: 'running' });
    }
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

describe('provider-event record order', () => {
  // The console runs the same fixture against its own merge (it cannot import this).
  test('matches the shared ordering fixture', () => {
    expect(orderProviderEventRecords(orderFixture.input)).toEqual(orderFixture.expected);
  });
});
