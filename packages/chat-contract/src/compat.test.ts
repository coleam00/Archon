import { expect, test } from 'bun:test';
import {
  PluginProtocolMismatchError,
  PluginRpc,
  streamPair,
} from '@archon/provider-contract/plugin';
import { z } from 'zod';
import type { ChatAttentionNoticeRequest } from './attention-notices';
import { connectChat, inspectChat } from './connect';
import { CHAT_PLUGIN_PROTOCOL } from './descriptor';
import baseline from './fixtures/archon-chat-1-baseline.schema.json';
import { descriptor } from './fixtures/descriptor';
import type { ChatRunEvent } from './run-events';
import { serveChat } from './serve';
import type { ChatResultFooter, ChatSend } from './wire';

// The published schema when archon-chat/1's compatibility promise started. Every
// archon-chat/1 peer since must keep speaking with the current code; a bump replaces it.
function baselineDef(name: keyof typeof baseline.$defs): z.ZodType {
  // JSON imports widen literal schema keywords such as type to string.
  return z.fromJSONSchema({
    ...baseline,
    $ref: `#/$defs/${name}`,
  } as unknown as z.core.JSONSchema.BaseSchema);
}

// Each message is sent minimal and full: the first catches a field that became required,
// the second one that was removed or narrowed.
const sends: ChatSend[] = [
  { conversationId: 'thread', text: 'minimal' },
  { conversationId: 'thread', text: 'reply', metadata: { category: 'workflow_result' } },
];
const footers: ChatResultFooter[] = [
  { conversationId: 'thread' },
  {
    conversationId: 'thread',
    cost: 0.02,
    tokens: { input: 1, output: 2, cacheRead: 3, total: 6, cost: 0.02 },
    stopReason: 'end_turn',
  },
];
const runEvents: ChatRunEvent[] = [
  { type: 'workflow_started', runId: 'run', conversationId: 'thread', workflowName: 'nightly' },
  {
    type: 'node_state',
    runId: 'run',
    nodeId: 'build',
    nodeName: 'Build',
    state: 'failed',
    durationMs: 10,
    error: 'exit 1',
  },
  {
    type: 'approval_pending',
    runId: 'run',
    nodeId: 'gate',
    message: 'Choose',
    decisions: [{ id: 'ship', label: 'Ship it' }],
    pauseId: 'pause',
    authoredOutcome: 'succeeded',
  },
  {
    type: 'terminal',
    runId: 'run',
    status: 'failed',
    error: 'failed',
    authoredOutcome: 'failed',
    totalCostUsd: 0.5,
  },
];
const notices: ChatAttentionNoticeRequest[] = [
  {
    destination: 'ops',
    notice: {
      type: 'gate',
      runId: 'run',
      workflowName: 'nightly',
      nodeId: 'review',
      pauseId: 'pause',
      gateType: 'approval',
      message: 'Review',
      decisions: [{ id: 'approve', label: 'Approve' }],
    },
  },
  {
    destination: 'ops',
    notice: {
      type: 'attention',
      runId: 'run',
      workflowName: 'nightly',
      nodeId: 'hold',
      pauseId: 'pause',
      message: 'Pick',
      form: 'select',
      options: [{ id: 'a', label: 'A' }],
    },
  },
  {
    destination: 'ops',
    conversationId: 'notice',
    notice: {
      type: 'terminal',
      runId: 'run',
      workflowName: 'nightly',
      status: 'completed',
      authoredOutcome: 'succeeded',
      totalCostUsd: 0.5,
    },
  },
];

test('the samples are baseline-shaped and cover every variant', () => {
  for (const send of sends) baselineDef('ChatSend').parse(send);
  for (const footer of footers) baselineDef('ChatResultFooter').parse(footer);
  for (const event of runEvents) baselineDef('ChatRunEvent').parse(event);
  for (const notice of notices) baselineDef('ChatAttentionNoticeRequest').parse(notice);
  expect(runEvents.map((event): string => event.type)).toEqual(
    baseline.$defs.ChatRunEvent.oneOf.map(variant => variant.properties.type.const)
  );
  expect(notices.map(({ notice }): string => notice.type)).toEqual(
    baseline.$defs.ChatAttentionNotice.oneOf.map(variant => variant.properties.type.const)
  );
});

test('the baseline is the current protocol', () => {
  expect(baseline.$defs.ChatPluginDescriptor.properties.protocol.const).toBe(CHAT_PLUGIN_PROTOCOL);
});

test('connect and install inspection name both chat protocols', async () => {
  for (const connect of [
    (io: ReturnType<typeof streamPair>['host']): Promise<unknown> => connectChat(io, descriptor),
    inspectChat,
  ]) {
    const pair = streamPair();
    const agent = new PluginRpc(pair.provider);
    agent.handle('initialize', () => ({ ...descriptor, protocol: 'archon-chat/2' }));
    const error: unknown = await connect(pair.host).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PluginProtocolMismatchError);
    expect(error).toMatchObject({
      plugin: 'test-chat',
      hostProtocol: CHAT_PLUGIN_PROTOCOL,
      pluginProtocol: 'archon-chat/2',
      message: expect.stringContaining(
        `plugin speaks protocol archon-chat/2; this Archon speaks protocol ${CHAT_PLUGIN_PROTOCOL}`
      ),
    });
    await agent.done;
    await agent.close();
  }
});

test('baseline-shaped host messages reach the current plugin', async () => {
  const received: unknown[] = [];
  const pair = streamPair();
  const stopped = serveChat(
    {
      descriptor,
      async start() {
        received.push('start');
      },
      async send(params) {
        received.push(params);
      },
      async resultFooter(params) {
        received.push(params);
      },
      onRunEvent(event) {
        received.push(event);
      },
      async attentionNotice(params) {
        received.push(params);
        return { conversationId: 'notice' };
      },
    },
    pair.provider
  );
  const host = new PluginRpc(pair.host);
  try {
    baselineDef('ChatEmpty').parse({});
    await host.request('initialize', {});
    await host.request('chat/start', {});
    for (const send of sends) await host.request('chat/send', send);
    for (const footer of footers) await host.request('chat/result_footer', footer);
    for (const event of runEvents) await host.notify('chat/run_event', event);
    for (const notice of notices) await host.request('chat/attention_notice', notice);
    expect(received).toEqual(['start', ...sends, ...footers, ...runEvents, ...notices]);
  } finally {
    await host.close();
    await stopped;
  }
});

test('current host messages reach a plugin pinned to the baseline', async () => {
  const pair = streamPair();
  const agent = new PluginRpc(pair.provider);
  const received: unknown[] = [];
  const rejected: unknown[] = [];
  const handle = (method: string, def: keyof typeof baseline.$defs, result: unknown): void => {
    agent.handle(method, params => {
      received.push(baselineDef(def).parse(params));
      return result;
    });
  };
  handle('initialize', 'ChatEmpty', descriptor);
  handle('chat/start', 'ChatEmpty', {});
  handle('chat/send', 'ChatSend', {});
  handle('chat/result_footer', 'ChatResultFooter', {});
  handle('chat/attention_notice', 'ChatAttentionNoticeRequest', { conversationId: 'notice' });
  agent.on('chat/run_event', params => {
    const parsed = baselineDef('ChatRunEvent').safeParse(params);
    (parsed.success ? received : rejected).push(params);
  });
  const chat = await connectChat(pair.host, descriptor);
  try {
    await chat.start();
    for (const send of sends) await chat.send(send);
    for (const footer of footers) await chat.resultFooter(footer);
    for (const event of runEvents) await chat.runEvent(event);
    for (const notice of notices) await chat.attentionNotice(notice);
    expect(rejected).toEqual([]);
    expect(received).toEqual([{}, {}, ...sends, ...footers, ...runEvents, ...notices]);
  } finally {
    await chat.close();
    await agent.close();
  }
});
