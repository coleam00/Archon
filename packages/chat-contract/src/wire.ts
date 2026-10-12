import { z } from 'zod';
import { tokenUsageSchema } from '@archon/provider-contract';
import { chatActorSchema, chatPluginDescriptorSchema, identityPlatformSchema } from './descriptor';
import { chatRunEventSchema, chatApprovalDecisionSchema } from './run-events';
import {
  chatSenderSchema,
  chatRejectedSchema,
  chatRunActionSchema,
  chatRunActionResponseSchema,
  runActionResultSchema,
} from './run-actions';

export const chatEmptySchema = z.strictObject({});
export const chatStartFailureSchema = z.object({ retryable: z.boolean() });
export const chatInboundSchema = z.object({
  conversationId: z.string().min(1),
  parentConversationId: z.string().min(1).optional(),
  text: z.string(),
  threadContext: z.string().optional(),
  sender: chatSenderSchema,
});
export type ChatInbound = z.infer<typeof chatInboundSchema>;
export const chatInboundResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted') }),
  chatRejectedSchema,
]);
export type ChatInboundResponse = z.infer<typeof chatInboundResponseSchema>;
export const chatSendSchema = z.object({
  conversationId: z.string().min(1),
  text: z.string(),
  metadata: z.record(z.string(), z.json()).optional(),
});
export type ChatSend = z.infer<typeof chatSendSchema>;
export const chatResultFooterSchema = z.object({
  conversationId: z.string().min(1),
  cost: z.number().optional(),
  tokens: tokenUsageSchema.optional(),
  stopReason: z.string().optional(),
});
export type ChatResultFooter = z.infer<typeof chatResultFooterSchema>;

export const chatWireSchemas = {
  IdentityPlatform: identityPlatformSchema,
  ChatActor: chatActorSchema,
  ChatPluginDescriptor: chatPluginDescriptorSchema,
  ChatEmpty: chatEmptySchema,
  ChatStartFailure: chatStartFailureSchema,
  ChatInbound: chatInboundSchema,
  ChatInboundResponse: chatInboundResponseSchema,
  ChatSend: chatSendSchema,
  ChatResultFooter: chatResultFooterSchema,
  ChatApprovalDecision: chatApprovalDecisionSchema,
  ChatRunEvent: chatRunEventSchema,
  ChatRunAction: chatRunActionSchema,
  ChatRunActionResponse: chatRunActionResponseSchema,
  RunActionResult: runActionResultSchema,
};
