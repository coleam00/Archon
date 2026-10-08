import type { ConversationLockManager } from '@archon/core';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import { ChatSupervisor, type InstalledChatPlugin } from './supervisor';
import { ChatPluginPlatform } from './platform';
import { registerChatInbound } from './inbound';
import { subscribeChatRunEvents } from './run-events';

export function createChatHost(
  installed: readonly InstalledChatPlugin[],
  streaming: Readonly<Record<string, 'stream' | 'batch'>>,
  locks: ConversationLockManager,
  platforms: Map<string, IWorkflowPlatform>,
  activePlatforms: string[]
): { start(): void; stop(): Promise<void> } {
  const supervisors = new Map<string, ChatSupervisor>();
  for (const plugin of installed) {
    const { descriptor } = plugin;
    const healthName = `Chat: ${descriptor.id}`;
    const supervisor = new ChatSupervisor(
      plugin,
      connection => {
        registerChatInbound(connection, descriptor, platform, locks, platforms);
      },
      live => {
        const index = activePlatforms.indexOf(healthName);
        if (live && index === -1) activePlatforms.push(healthName);
        if (!live && index !== -1) activePlatforms.splice(index, 1);
      }
    );
    const platform = new ChatPluginPlatform(descriptor, supervisor, streaming);
    platforms.set(descriptor.id, platform);
    supervisors.set(descriptor.id, supervisor);
  }
  let unsubscribe: (() => void) | undefined;
  return {
    start(): void {
      unsubscribe ??= installed.length
        ? subscribeChatRunEvents(supervisors)
        : (): void => undefined;
      for (const supervisor of supervisors.values()) supervisor.start();
    },
    async stop(): Promise<void> {
      unsubscribe?.();
      await Promise.all([...supervisors.values()].map(supervisor => supervisor.stop()));
    },
  };
}
