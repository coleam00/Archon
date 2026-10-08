import { Readable, Writable } from 'node:stream';
import { PluginRpc, PluginRemoteError, type PluginIO } from '@archon/provider-contract/plugin';
import { chatPluginDescriptorSchema, type ChatPluginDescriptor } from './descriptor';
import { chatRunEventSchema, type ChatRunEvent } from './run-events';
import {
  chatRunActionSchema,
  chatRunActionResponseSchema,
  type ChatRunAction,
  type ChatRunActionResponse,
} from './run-actions';
import {
  chatEmptySchema,
  chatInboundSchema,
  chatInboundResponseSchema,
  chatSendSchema,
  chatResultFooterSchema,
  type ChatInbound,
  type ChatInboundResponse,
  type ChatSend,
  type ChatResultFooter,
} from './wire';

export class ChatStartError extends PluginRemoteError {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(-32000, message, { retryable });
    this.name = 'ChatStartError';
  }
}

export interface ChatContext {
  inbound(message: ChatInbound): Promise<ChatInboundResponse>;
  runAction(action: ChatRunAction): Promise<ChatRunActionResponse>;
}
export interface ChatPlugin {
  descriptor: ChatPluginDescriptor;
  start(ctx: ChatContext): Promise<void>;
  send(params: ChatSend): Promise<void>;
  resultFooter?(params: ChatResultFooter): Promise<void>;
  onRunEvent?(event: ChatRunEvent): void | Promise<void>;
}

export async function serveChat(
  plugin: ChatPlugin,
  io: PluginIO = {
    readable: Readable.toWeb(process.stdin),
    writable: Writable.toWeb(process.stdout),
  }
): Promise<void> {
  const descriptor = chatPluginDescriptorSchema.parse(plugin.descriptor);
  const resultFooter = plugin.resultFooter?.bind(plugin);
  const onRunEvent = plugin.onRunEvent?.bind(plugin);
  if (Boolean(descriptor.capabilities.resultFooter) !== Boolean(resultFooter))
    throw new Error('resultFooter capability must match its handler');
  if (Boolean(descriptor.capabilities.runEvents) !== Boolean(onRunEvent))
    throw new Error('runEvents capability must match its handler');
  const rpc = new PluginRpc(io);
  rpc.plugin = descriptor.id;
  let initialized = false;
  function requireInitialized(): void {
    if (!initialized) throw new Error('initialize must complete before chat requests');
  }
  const ctx: ChatContext = {
    async inbound(message) {
      return rpc.parse(
        chatInboundResponseSchema,
        await rpc.request('chat/inbound', chatInboundSchema.parse(message))
      );
    },
    async runAction(action) {
      return rpc.parse(
        chatRunActionResponseSchema,
        await rpc.request('chat/run_action', chatRunActionSchema.parse(action))
      );
    },
  };
  rpc.handle('initialize', raw => {
    chatEmptySchema.parse(raw);
    initialized = true;
    return descriptor;
  });
  rpc.handle('chat/start', async raw => {
    requireInitialized();
    chatEmptySchema.parse(raw);
    try {
      await plugin.start(ctx);
    } catch (error) {
      if (error instanceof ChatStartError) throw error;
      // Unclassified failures cannot safely drive a supervisor's retry policy.
      throw new ChatStartError(
        error instanceof Error ? error.message : 'Chat plugin start failed',
        false
      );
    }
    return {};
  });
  rpc.handle('chat/send', async raw => {
    requireInitialized();
    await plugin.send(chatSendSchema.parse(raw));
    return {};
  });
  if (resultFooter) {
    rpc.handle('chat/result_footer', async raw => {
      requireInitialized();
      await resultFooter(chatResultFooterSchema.parse(raw));
      return {};
    });
  }
  const rendering = new Set<Promise<void>>();
  if (onRunEvent) {
    rpc.on('chat/run_event', raw => {
      requireInitialized();
      const event = rpc.parse(chatRunEventSchema, raw);
      const task = Promise.resolve()
        .then(() => onRunEvent(event))
        .catch(() => {
          // Rendering failures must not disconnect chat or expose message contents in logs.
          console.error(`Chat plugin ${descriptor.id}: failed to render ${event.type}`);
        });
      rendering.add(task);
      void task.finally(() => rendering.delete(task));
    });
  }
  try {
    await rpc.done;
  } finally {
    await rpc.drain();
    await Promise.all(rendering);
    await rpc.close();
  }
}
