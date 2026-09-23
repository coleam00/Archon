import { z } from '@hono/zod-openapi';
import { sourceReceiptAcceptanceSchema } from './schemas/resource-start';

export interface WebhookSourceRequest {
  body: string;
  headers: Record<string, string>;
  receivedAt: string;
}

export const webhookSourceResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('rejected'), reason: z.literal('unauthenticated') }).strict(),
  z.object({ status: z.literal('received'), acceptance: sourceReceiptAcceptanceSchema }).strict(),
]);
export type WebhookSourceResult = z.infer<typeof webhookSourceResultSchema>;

export interface WebhookSourcePlugin {
  receive(request: WebhookSourceRequest): Promise<WebhookSourceResult>;
}

export type WebhookSourcePluginFactory = (input: {
  sourceInstanceId: string;
  config: unknown;
}) => WebhookSourcePlugin | Promise<WebhookSourcePlugin>;
