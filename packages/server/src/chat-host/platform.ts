import {
  chatSendSchema,
  type ChatPluginDescriptor,
  type ConnectedChat,
} from '@archon/chat-contract';
import type { IPlatformAdapter, MessageMetadata } from '@archon/core';

export class ChatPluginUnavailableError extends Error {
  constructor(id: string) {
    super(`Chat plugin ${id} is unavailable`);
    this.name = 'ChatPluginUnavailableError';
  }
}

export interface ChatConnection {
  request(operation: (connection: ConnectedChat) => Promise<void>): Promise<void>;
}

export class ChatPluginPlatform implements IPlatformAdapter {
  readonly capabilities: IPlatformAdapter['capabilities'];
  readonly sendResultFooter?: IPlatformAdapter['sendResultFooter'];
  readonly formatWorkflowCommand?: IPlatformAdapter['formatWorkflowCommand'];

  constructor(
    private readonly descriptor: ChatPluginDescriptor,
    private readonly connection: ChatConnection,
    private readonly streaming: Readonly<Record<string, 'stream' | 'batch'>>
  ) {
    this.capabilities = {
      messagePersistence: 'core',
      defaultWorkflowDispatch: descriptor.capabilities.defaultWorkflowDispatch,
      ...(descriptor.capabilities.canDetachProject ? { canDetachProject: true } : {}),
    };
    if (descriptor.capabilities.resultFooter) {
      this.sendResultFooter = (conversationId, info): Promise<void> =>
        connection.request(chat => chat.resultFooter({ conversationId, ...info }));
    }
    if (descriptor.workflowCommand) {
      const { prefix } = descriptor.workflowCommand;
      this.formatWorkflowCommand = (command): string => prefix + command;
    }
  }

  getPlatformType(): string {
    return this.descriptor.id;
  }

  getStreamingMode(): 'stream' | 'batch' {
    return (
      this.streaming[this.descriptor.id] ?? this.descriptor.policy.streaming?.defaultMode ?? 'batch'
    );
  }

  sendMessage(conversationId: string, text: string, metadata?: MessageMetadata): Promise<void> {
    const params = chatSendSchema.parse({ conversationId, text, metadata });
    return this.connection.request(chat => chat.send(params));
  }

  async ensureThread(conversationId: string): Promise<string> {
    return conversationId;
  }

  async start(): Promise<void> {
    return undefined;
  }
  stop(): void {
    return undefined;
  }
}
