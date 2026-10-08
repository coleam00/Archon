import { expect, test } from 'bun:test';
import type { ConnectedChat } from '@archon/chat-contract';
import { ChatPluginPlatform, ChatPluginUnavailableError } from './platform';
import { descriptor } from './fixtures/descriptor';

test('descriptor owns capabilities and optional operations; config owns streaming', async () => {
  const sends: unknown[] = [];
  const footers: unknown[] = [];
  const connection: ConnectedChat = {
    descriptor,
    closed: Promise.resolve(),
    start: async () => {},
    close: async () => {},
    onInbound() {},
    onRunAction() {},
    runEvent: async () => {},
    send: async params => {
      sends.push(params);
    },
    resultFooter: async params => {
      footers.push(params);
    },
  };
  const platform = new ChatPluginPlatform(
    descriptor,
    { request: operation => operation(connection) },
    { [descriptor.id]: 'stream' }
  );
  expect(platform.capabilities).toEqual({
    messagePersistence: 'core',
    defaultWorkflowDispatch: 'foreground',
  });
  expect(platform.getPlatformType()).toBe(descriptor.id);
  expect(platform.getStreamingMode()).toBe('stream');
  expect(await platform.ensureThread('thread-1')).toBe('thread-1');
  expect(platform.formatWorkflowCommand?.('run fixture')).toBe('/fixture-workflow run fixture');
  await platform.sendMessage('thread-1', 'hello', { category: 'workflow_status', segment: 'new' });
  await platform.sendResultFooter?.('thread-1', { cost: 1 });
  expect(sends).toEqual([
    {
      conversationId: 'thread-1',
      text: 'hello',
      metadata: { category: 'workflow_status', segment: 'new' },
    },
  ]);
  expect(footers).toEqual([{ conversationId: 'thread-1', cost: 1 }]);
  const minimal = new ChatPluginPlatform(
    {
      ...descriptor,
      capabilities: { defaultWorkflowDispatch: 'background' },
      workflowCommand: undefined,
    },
    {
      request: async () => {
        throw new ChatPluginUnavailableError(descriptor.id);
      },
    },
    {}
  );
  expect(minimal.sendResultFooter).toBeUndefined();
  expect(minimal.formatWorkflowCommand).toBeUndefined();
  await expect(minimal.sendMessage('thread-1', 'hello')).rejects.toBeInstanceOf(
    ChatPluginUnavailableError
  );
});
