import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PluginRpc, PluginRemoteError, type PluginIO } from '@archon/provider-contract/plugin';
import {
  CHAT_PLUGIN_PROTOCOL,
  chatPluginDescriptorSchema,
  type ChatPluginDescriptor,
} from './descriptor';
import { chatRunEventSchema, type ChatRunEvent } from './run-events';
import {
  chatAttentionNoticeRequestSchema,
  chatAttentionNoticeResponseSchema,
  type ChatAttentionNoticeRequest,
  type ChatAttentionNoticeResponse,
} from './attention-notices';
import {
  chatRunActionSchema,
  chatRunActionResponseSchema,
  type ChatRunAction,
  type ChatRunActionResponse,
} from './run-actions';
import { ChatStartError } from './serve';
import {
  chatEmptySchema,
  chatStartFailureSchema,
  chatInboundSchema,
  chatInboundResponseSchema,
  chatSendSchema,
  chatResultFooterSchema,
  type ChatInbound,
  type ChatInboundResponse,
  type ChatSend,
  type ChatResultFooter,
} from './wire';

export interface ConnectedChat {
  readonly descriptor: ChatPluginDescriptor;
  readonly closed: Promise<void>;
  start(): Promise<void>;
  send(params: ChatSend): Promise<void>;
  resultFooter(params: ChatResultFooter): Promise<void>;
  runEvent(event: ChatRunEvent): Promise<void>;
  attentionNotice(params: ChatAttentionNoticeRequest): Promise<ChatAttentionNoticeResponse>;
  onInbound(
    handler: (message: ChatInbound) => ChatInboundResponse | Promise<ChatInboundResponse>
  ): void;
  onRunAction(
    handler: (action: ChatRunAction) => ChatRunActionResponse | Promise<ChatRunActionResponse>
  ): void;
  close(): Promise<void>;
}

// Reads only what a plugin on any protocol advertises, so a mismatch names both versions
// instead of failing the full descriptor parse.
const advertisedProtocolSchema = chatPluginDescriptorSchema
  .pick({ id: true })
  .extend({ protocol: z.string().regex(/^archon-chat\/[1-9]\d*$/) });

async function initialize(rpc: PluginRpc): Promise<ChatPluginDescriptor> {
  const raw = await rpc.request('initialize', {});
  const advertised = advertisedProtocolSchema.safeParse(raw);
  if (advertised.success && advertised.data.protocol !== CHAT_PLUGIN_PROTOCOL) {
    rpc.plugin = advertised.data.id;
    throw rpc.mismatch(CHAT_PLUGIN_PROTOCOL, advertised.data.protocol);
  }
  return rpc.parse(chatPluginDescriptorSchema, raw);
}

export async function inspectChat(io: PluginIO): Promise<ChatPluginDescriptor> {
  const rpc = new PluginRpc(io);
  try {
    return await initialize(rpc);
  } finally {
    await rpc.close();
  }
}

export async function connectChat(
  io: PluginIO,
  expectedDescriptor: ChatPluginDescriptor
): Promise<ConnectedChat> {
  const expected = chatPluginDescriptorSchema.parse(expectedDescriptor);
  const rpc = new PluginRpc(io);
  rpc.plugin = expected.id;
  let inbound: Parameters<ConnectedChat['onInbound']>[0] | undefined;
  let runAction: Parameters<ConnectedChat['onRunAction']>[0] | undefined;
  rpc.handle('chat/inbound', async raw => {
    const message = chatInboundSchema.parse(raw);
    if (!inbound) throw new Error('No chat inbound handler registered');
    return chatInboundResponseSchema.parse(await inbound(message));
  });
  rpc.handle('chat/run_action', async raw => {
    const action = chatRunActionSchema.parse(raw);
    if (!runAction) throw new Error('No chat run-action handler registered');
    return chatRunActionResponseSchema.parse(await runAction(action));
  });
  let descriptor: ChatPluginDescriptor;
  try {
    descriptor = await initialize(rpc);
    if (!isDeepStrictEqual(descriptor, expected))
      throw rpc.error('descriptor changed since install; update this plugin');
  } catch (error) {
    await rpc.close();
    throw error;
  }
  return {
    descriptor,
    closed: rpc.done,
    onInbound(handler): void {
      inbound = handler;
    },
    onRunAction(handler): void {
      runAction = handler;
    },
    close: () => rpc.close(),
    async start(): Promise<void> {
      let raw: unknown;
      try {
        raw = await rpc.request('chat/start', {});
      } catch (error) {
        if (error instanceof PluginRemoteError && error.code === -32000) {
          const failure = rpc.parse(chatStartFailureSchema, error.data);
          throw new ChatStartError(error.message, failure.retryable);
        }
        throw error;
      }
      rpc.parse(chatEmptySchema, raw);
    },
    async send(params): Promise<void> {
      rpc.parse(chatEmptySchema, await rpc.request('chat/send', chatSendSchema.parse(params)));
    },
    async resultFooter(params): Promise<void> {
      if (!descriptor.capabilities.resultFooter) throw rpc.error('resultFooter is not declared');
      rpc.parse(
        chatEmptySchema,
        await rpc.request('chat/result_footer', chatResultFooterSchema.parse(params))
      );
    },
    async runEvent(event): Promise<void> {
      if (!descriptor.capabilities.runEvents) throw rpc.error('runEvents is not declared');
      await rpc.notify('chat/run_event', chatRunEventSchema.parse(event));
    },
    async attentionNotice(params): Promise<ChatAttentionNoticeResponse> {
      if (!descriptor.capabilities.attentionNotices)
        throw rpc.error('attentionNotices is not declared');
      return rpc.parse(
        chatAttentionNoticeResponseSchema,
        await rpc.request('chat/attention_notice', chatAttentionNoticeRequestSchema.parse(params))
      );
    },
  };
}
