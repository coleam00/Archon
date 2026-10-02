import { describe, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { IWorkflowPlatform } from './deps';
import { createProviderEventHandler } from './provider-events';
import type { IWorkflowStore } from './store';

const trackTempRoot = trackTempRoots();

type CreateEvent = IWorkflowStore['createWorkflowEvent'];

async function makeHandler(): Promise<{
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
    configuredMcpServers: new Set(),
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

  test('records a tool completion only when the provider reports one', async () => {
    const { handler, rows } = await makeHandler();

    await handler.handle({ type: 'tool_call', toolCallId: 'a', name: 'Read' });
    await handler.handle({ type: 'tool_call', toolCallId: 'b', name: 'Read' });
    await handler.handle({ type: 'tool_call_update', toolCallId: 'b', status: 'cancelled' });
    // A stray update for a call that never started is the provider's bug, not a completion.
    await handler.handle({ type: 'tool_call_update', toolCallId: 'never', status: 'completed' });
    await handler.handle({ type: 'agent_message_chunk', text: 'done' });

    expect(rows.filter(row => row.event_type === 'tool_called')).toHaveLength(2);
    // Tool `a` never closed: the engine does not invent an `unknown` completion for it.
    expect(rows.filter(row => row.event_type === 'tool_completed').map(row => row.data)).toEqual([
      expect.objectContaining({ tool_call_id: 'b', tool_outcome: 'interrupted' }),
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
});
