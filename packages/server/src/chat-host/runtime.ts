import type { ConversationLockManager } from '@archon/core';
import type { AttentionNoticeRoute } from '@archon/core/config';
import type { IWorkflowPlatform } from '@archon/workflows/deps';
import { ChatSupervisor, type ChatPluginState, type InstalledChatPlugin } from './supervisor';
import { ChatAttentionDestination } from './attention-destination';
import { ChatPluginPlatform } from './platform';
import { registerChatInbound } from './inbound';
import { subscribeChatRunEvents } from './run-events';

export function createChatHost(
  installed: readonly InstalledChatPlugin[],
  streaming: Readonly<Record<string, 'stream' | 'batch'>>,
  locks: ConversationLockManager,
  platforms: Map<string, IWorkflowPlatform>,
  activePlatforms: string[],
  attention: { routes: readonly AttentionNoticeRoute[]; inlinePlatforms: ReadonlySet<string> } = {
    routes: [],
    inlinePlatforms: new Set(),
  }
): {
  start(): void;
  stop(): Promise<void>;
  attentionDestinations: ChatAttentionDestination[];
} {
  const supervisors = new Map<string, ChatSupervisor>();
  const states = new Map<string, ChatPluginState>();
  for (const plugin of installed) {
    const { descriptor } = plugin;
    const healthName = `Chat: ${descriptor.id}`;
    let listed: string | undefined;
    const supervisor = new ChatSupervisor(
      plugin,
      connection => {
        registerChatInbound(connection, descriptor, platform, locks, platforms);
      },
      state => {
        states.set(descriptor.id, state);
        // While the host runs, health lists each installed plugin with its state; live is the bare name.
        if (listed !== undefined) activePlatforms.splice(activePlatforms.indexOf(listed), 1);
        listed =
          state === 'stopped'
            ? undefined
            : state === 'live'
              ? healthName
              : `${healthName} (${state})`;
        if (listed !== undefined) activePlatforms.push(listed);
      }
    );
    const platform = new ChatPluginPlatform(descriptor, supervisor, streaming);
    platforms.set(descriptor.id, platform);
    supervisors.set(descriptor.id, supervisor);
  }
  const attentionDestinations = attention.routes.map(
    route =>
      new ChatAttentionDestination(
        route,
        supervisors.get(route.platform),
        () => states.get(route.platform),
        attention.inlinePlatforms
      )
  );
  let unsubscribe: (() => void) | undefined;
  return {
    attentionDestinations,
    start(): void {
      unsubscribe ??= installed.length
        ? subscribeChatRunEvents(supervisors, platforms)
        : (): void => undefined;
      for (const supervisor of supervisors.values()) supervisor.start();
    },
    async stop(): Promise<void> {
      unsubscribe?.();
      await Promise.all([...supervisors.values()].map(supervisor => supervisor.stop()));
    },
  };
}
