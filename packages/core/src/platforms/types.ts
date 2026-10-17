import type { ChatPluginDescriptor } from '@archon/chat-contract/descriptor';

export interface PlatformPolicy extends Readonly<ChatPluginDescriptor['policy']> {
  readonly id: string;
}
