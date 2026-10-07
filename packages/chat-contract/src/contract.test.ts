import { expect, test, spyOn } from 'bun:test';
import {
  PluginRpc,
  PluginProtocolError,
  PluginRemoteError,
  streamPair,
} from '@archon/provider-contract/plugin';
import {
  serveChat,
  connectChat,
  ChatStartError,
  chatActorSchema,
  chatPluginDescriptorSchema,
  chatRunEventSchema,
  chatRunActionSchema,
  type ChatPluginDescriptor,
  type ChatContext,
  type ChatRunActionResponse,
  type ChatRunEvent,
} from './index';
import { runChatConformance, type ChatConformanceFixture } from './conformance';

const descriptor = {
  protocol: 'archon-chat/1',
  id: 'test-chat',
  displayName: 'Test chat',
  version: '1',
  capabilities: { defaultWorkflowDispatch: 'background', resultFooter: true, runEvents: true },
  workflowCommand: { prefix: '/archon-workflow ' },
  policy: {
    workspaceRetention: 'age-based',
    streaming: { defaultMode: 'batch', envVar: 'CHAT_STREAMING' },
  },
  allowlist: { envVar: 'CHAT_ALLOWED' },
} satisfies ChatPluginDescriptor;

async function fixture(startError?: Error): Promise<
  ChatConformanceFixture & {
    sent: string[];
    events: ChatRunEvent[];
    footers: number[];
  }
> {
  let ctx: ChatContext | undefined;
  let corruptInbound = false;
  let failRender = false;
  let rendered = (): void => {};
  const sent: string[] = [];
  const events: ChatRunEvent[] = [];
  const footers: number[] = [];
  const pair = streamPair();
  const writer = pair.provider.writable.getWriter();
  const stopped = serveChat(
    {
      descriptor,
      async start(context) {
        if (startError) throw startError;
        ctx = context;
      },
      async send(params) {
        sent.push(params.text);
      },
      async resultFooter(params) {
        footers.push(params.cost ?? 0);
      },
      onRunEvent(event) {
        events.push(event);
        if (failRender) {
          failRender = false;
          rendered();
          throw new Error('fixture render failure');
        }
      },
    },
    {
      readable: pair.provider.readable,
      writable: new WritableStream({
        async write(value) {
          if (corruptInbound) {
            corruptInbound = false;
            const message = JSON.parse(new TextDecoder().decode(value));
            message.params.sender = {};
            value = new TextEncoder().encode(JSON.stringify(message) + '\n');
          }
          await writer.write(value);
        },
        async close() {
          await writer.close();
        },
      }),
    }
  );
  const chat = await connectChat(pair.host, descriptor);
  function context(): ChatContext {
    if (!ctx) throw new Error('fixture not started');
    return ctx;
  }
  return {
    chat,
    stopped,
    sent,
    events,
    footers,
    inbound: message => context().inbound(message),
    runAction: action => context().runAction(action),
    malformedInbound() {
      corruptInbound = true;
      return context().inbound({
        conversationId: 'fixture',
        text: '',
        sender: { platformUserId: 'allowed' },
      });
    },
    failNextRunEvent() {
      failRender = true;
      return new Promise(resolve => {
        rendered = resolve;
      });
    },
  };
}

test('bidirectional requests preserve messages, every action result, send, footer and run events', async () => {
  const f = await fixture();
  const received: unknown[] = [];
  f.chat.onInbound(message => {
    received.push(message);
    return message.sender.platformUserId === 'allowed'
      ? { status: 'accepted' }
      : { status: 'rejected', reason: 'not_allowed' };
  });
  let response: ChatRunActionResponse = { status: 'rejected', reason: 'not_allowed' };
  f.chat.onRunAction(action => {
    received.push(action);
    return response;
  });
  try {
    await f.chat.start();
    const message = {
      conversationId: 'thread',
      parentConversationId: 'channel',
      text: 'whole message',
      threadContext: 'history',
      sender: { platformUserId: 'allowed', displayName: 'Name' },
    };
    expect(await f.inbound(message)).toEqual({ status: 'accepted' });
    expect(received[0]).toEqual(message);
    expect(await f.inbound({ ...message, sender: { platformUserId: 'denied' } })).toEqual({
      status: 'rejected',
      reason: 'not_allowed',
    });
    const responses: ChatRunActionResponse[] = [
      { status: 'done', result: { kind: 'approved', type: 'approval_gate', resumed: true } },
      {
        status: 'done',
        result: {
          kind: 'rejected',
          cancelled: false,
          maxAttemptsReached: false,
          writeBack: true,
          newMode: false,
          resumed: false,
        },
      },
      { status: 'done', result: { kind: 'cooperative', cancelled: false } },
      {
        status: 'done',
        result: {
          kind: 'stopped',
          pid: 123,
          cleanupWarnings: ['cleanup failed'],
          cascadeFailures: 2,
          blockedParentRunId: 'parent',
        },
      },
      { status: 'rejected', reason: 'not_allowed' },
      { status: 'forbidden', message: 'Only the starter or an admin' },
      { status: 'refused', message: 'No live owner answered', abandonHint: 'abandon run' },
    ];
    for (const result of responses) {
      response = result;
      expect(await f.runAction({ action: 'cancel', runId: 'run', sender: message.sender })).toEqual(
        result
      );
    }
    const text = '🦊'.repeat(20000);
    await f.chat.send({
      conversationId: 'thread',
      text,
      metadata: { category: 'workflow_result' },
    });
    await f.chat.resultFooter({
      conversationId: 'thread',
      cost: 0.02,
      tokens: { input: 1, output: 2 },
    });
    const event: ChatRunEvent = {
      type: 'approval_pending',
      runId: 'run',
      nodeId: 'gate',
      pauseId: 'pause',
      message: 'Choose',
      decisions: [{ id: 'ship', label: 'Ship it' }],
    };
    await f.chat.runEvent(event);
    await f.chat.send({ conversationId: 'thread', text: 'barrier' });
    expect(f.sent).toEqual([text, 'barrier']);
    expect(f.footers).toEqual([0.02]);
    expect(f.events).toEqual([event]);
  } finally {
    await f.chat.close();
    await f.stopped;
  }
});

test('conformance exercises malformed traffic, rendering containment and graceful closure', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await runChatConformance(() => fixture())).toEqual([]);
    expect(log).toHaveBeenCalledWith('Chat plugin test-chat: failed to render terminal');
  } finally {
    log.mockRestore();
  }
});

test('start failures retain typed retry policy and unclassified errors fail non-retryably', async () => {
  for (const retryable of [true, false]) {
    const f = await fixture(new ChatStartError('missing config', retryable));
    try {
      await expect(f.chat.start()).rejects.toMatchObject({
        name: 'ChatStartError',
        retryable,
        message: 'missing config',
      });
    } finally {
      await f.chat.close();
      await f.stopped;
    }
    expect(await runChatConformance(() => fixture(new ChatStartError('typed', retryable)))).toEqual(
      []
    );
  }
  const f = await fixture(new Error('native failure detail'));
  try {
    await expect(f.chat.start()).rejects.toMatchObject({
      retryable: false,
      message: 'native failure detail',
    });
  } finally {
    await f.chat.close();
    await f.stopped;
  }
});

test('descriptor comparison checks policy, capabilities and command prefix regardless of key order', async () => {
  for (const changed of [
    { ...descriptor, version: '2' },
    { ...descriptor, workflowCommand: { prefix: '/changed ' } },
    { ...descriptor, policy: { workspaceRetention: 'retain' } },
    {
      ...descriptor,
      capabilities: { defaultWorkflowDispatch: 'background', runEvents: true },
    },
    {
      ...descriptor,
      capabilities: { defaultWorkflowDispatch: 'background', resultFooter: true },
    },
  ]) {
    const pair = streamPair();
    const peer = new PluginRpc(pair.provider);
    peer.handle('initialize', () => changed);
    try {
      await expect(connectChat(pair.host, descriptor)).rejects.toBeInstanceOf(PluginProtocolError);
      await peer.done;
    } finally {
      await peer.close();
    }
  }
  const pair = streamPair();
  const peer = new PluginRpc(pair.provider);
  const { policy, ...rest } = descriptor;
  peer.handle('initialize', () => ({ policy, ...rest }));
  const chat = await connectChat(pair.host, descriptor);
  await chat.close();
  await peer.done;
  await peer.close();
});

test('malformed reply payloads reject the call and leave the connection usable', async () => {
  const pair = streamPair();
  const peer = new PluginRpc(pair.provider);
  peer.handle('initialize', () => descriptor);
  peer.handle('chat/start', () => {
    throw new PluginRemoteError(-32000, 'failure', { retryable: 'yes' });
  });
  let malformed = true;
  peer.handle('chat/send', () => {
    if (malformed) {
      malformed = false;
      return { unexpected: true };
    }
    return {};
  });
  const chat = await connectChat(pair.host, descriptor);
  try {
    await expect(chat.start()).rejects.toBeInstanceOf(PluginProtocolError);
    await expect(chat.send({ conversationId: 'thread', text: '' })).rejects.toBeInstanceOf(
      PluginProtocolError
    );
    await chat.send({ conversationId: 'thread', text: 'valid reply' });
  } finally {
    await chat.close();
    await peer.close();
  }
});

test('optional capabilities are absent and cannot be invoked when undeclared', async () => {
  const pair = streamPair();
  const basic = { ...descriptor, capabilities: { defaultWorkflowDispatch: 'foreground' as const } };
  const stopped = serveChat(
    { descriptor: basic, async start() {}, async send() {} },
    pair.provider
  );
  const chat = await connectChat(pair.host, basic);
  try {
    await chat.start();
    await expect(chat.resultFooter({ conversationId: 'thread' })).rejects.toThrow('not declared');
    await expect(
      chat.runEvent({ type: 'terminal', runId: 'run', status: 'completed' })
    ).rejects.toThrow('not declared');
  } finally {
    await chat.close();
    await stopped;
  }
  await expect(
    serveChat({ descriptor, async start() {}, async send() {} }, pair.provider)
  ).rejects.toThrow('capability must match');
});

test('schemas constrain actor, identity, protocol, events and structured gate responses', () => {
  expect(chatActorSchema.safeParse({ kind: 'operator' }).success).toBe(false);
  expect(chatActorSchema.parse({ kind: 'user', userId: 'id' })).toEqual({
    kind: 'user',
    userId: 'id',
  });
  for (const id of ['', 'UPPER', '-chat', 'a'.repeat(33)]) {
    expect(chatPluginDescriptorSchema.safeParse({ ...descriptor, id }).success).toBe(false);
  }
  expect(
    chatPluginDescriptorSchema.safeParse({ ...descriptor, protocol: 'archon-chat/2' }).success
  ).toBe(false);
  expect(chatRunEventSchema.safeParse({ type: 'provider_event', runId: 'run' }).success).toBe(
    false
  );
  for (const event of [
    { type: 'workflow_started', runId: 'run', conversationId: 'thread', workflowName: 'workflow' },
    { type: 'node_state', runId: 'run', nodeId: 'node', nodeName: 'Node', state: 'running' },
    {
      type: 'terminal',
      runId: 'run',
      status: 'failed',
      authoredOutcome: 'failed',
      totalCostUsd: 0.5,
    },
  ] satisfies ChatRunEvent[])
    expect(chatRunEventSchema.parse(event)).toEqual(event);
  const target = { runId: 'run', sender: { platformUserId: 'user' } };
  expect(chatRunActionSchema.safeParse({ ...target, action: 'respond' }).success).toBe(false);
  const action = chatRunActionSchema.parse({
    ...target,
    action: 'respond',
    response: { decision: 'ship', nodeId: 'node', pauseId: 'pause', text: 'feedback' },
  });
  expect(action.action).toBe('respond');
  if (action.action === 'respond')
    expect(action.response).toEqual({
      decision: 'ship',
      nodeId: 'node',
      pauseId: 'pause',
      text: 'feedback',
    });
});

test('closure rejects pending calls with typed failure on closed', async () => {
  const pair = streamPair();
  const peer = new PluginRpc(pair.provider);
  let observed = (): void => {};
  const requested = new Promise<void>(resolve => {
    observed = resolve;
  });
  peer.handle('initialize', () => descriptor);
  peer.handle('chat/send', () => {
    observed();
    return new Promise(() => {});
  });
  const chat = await connectChat(pair.host, descriptor);
  const sending = chat.send({ conversationId: 'thread', text: '' });
  await requested;
  await peer.close();
  await expect(sending).rejects.toBeInstanceOf(PluginProtocolError);
  await expect(chat.closed).rejects.toMatchObject({ plugin: descriptor.id, reason: 'closed' });
  await chat.close();
});

test('conformance refuses fabricated inbound success that never reached the host', async () => {
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const violations = await runChatConformance(async () => {
      const f = await fixture();
      return {
        ...f,
        async inbound(message) {
          return message.sender.platformUserId === 'allowed'
            ? { status: 'accepted' }
            : { status: 'rejected', reason: 'not_allowed' };
        },
      };
    });
    expect(violations).toEqual([
      'inbound allowed: inbound did not reach the host exactly once',
      'inbound denied: inbound did not reach the host exactly once',
    ]);
  } finally {
    log.mockRestore();
  }
});
