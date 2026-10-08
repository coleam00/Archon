import type { ChatPluginDescriptor } from '@archon/chat-contract';

export interface PlatformPolicy extends Readonly<ChatPluginDescriptor['policy']> {
  readonly id: string;
}
