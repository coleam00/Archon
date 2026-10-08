import { expect, spyOn, test } from 'bun:test';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import { createChatHost } from './runtime';
import { ChatPluginPlatform, ChatPluginUnavailableError } from './platform';
import { ChatSupervisor } from './supervisor';
import { testTimeout } from '@archon/paths/test-utils';
import { descriptor } from './fixtures/descriptor';

async function until(check: () => boolean) {
  const deadline = Date.now() + testTimeout(2000);
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Chat host did not become live');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test(
  'platform registration precedes readiness, and health follows process liveness',
  async () => {
    const platforms = new Map<string, IWorkflowPlatform>();
    const health = ['Web'];
    const start = spyOn(ChatSupervisor.prototype, 'start');
    const host = createChatHost(
      [{ descriptor, argv: [process.execPath, `${import.meta.dir}/fixtures/plugin.ts`, 'normal'] }],
      {},
      new ConversationLockManager(),
      platforms,
      health
    );
    try {
      const platform = platforms.get(descriptor.id);
      expect(platform).toBeInstanceOf(ChatPluginPlatform);
      expect(health).toEqual(['Web']);
      expect(start).not.toHaveBeenCalled();
      await expect(platform?.sendMessage('thread', 'hello')).rejects.toBeInstanceOf(
        ChatPluginUnavailableError
      );
      host.start();
      expect(start).toHaveBeenCalledTimes(1);
      await until(() => health.includes(`Chat: ${descriptor.id}`));
      await platform?.sendMessage('thread', 'hello');
    } finally {
      await host.stop();
      start.mockRestore();
    }
    expect(health).toEqual(['Web']);
    expect(platforms.has(descriptor.id)).toBe(true);
  },
  testTimeout(5000)
);

test('no receipts leave platform and health registries unchanged', async () => {
  const platforms = new Map<string, IWorkflowPlatform>();
  const health = ['Web'];
  const host = createChatHost([], {}, new ConversationLockManager(), platforms, health);
  host.start();
  await host.stop();
  expect(platforms.size).toBe(0);
  expect(health).toEqual(['Web']);
});
