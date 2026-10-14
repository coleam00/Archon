import { attentionNoticeKindSchema } from '@archon/workflows/schemas/attention-notice';
import { z } from '@hono/zod-openapi';

export const webPushEndpointSchema = z.url({
  protocol: /^https$/,
  error: 'A push endpoint must be a valid HTTPS URL',
});
export const webPushSubscriptionSchema = z
  .object({
    endpoint: webPushEndpointSchema,
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
      auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    }),
  })
  .openapi('WebPushSubscription');
export const webPushDeleteSchema = z
  .object({ endpoint: webPushEndpointSchema })
  .openapi('WebPushDelete');
export const webPushKeySchema = z.object({ publicKey: z.string() }).openapi('WebPushKey');
export const webPushSuccessSchema = z
  .object({ success: z.literal(true) })
  .openapi('WebPushSuccess');
export const webPushSubscriptionRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  endpoint: webPushEndpointSchema,
  p256dh: z.string(),
  auth: z.string(),
  created_at: z.union([z.date(), z.string()]),
});
export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;
export type WebPushSubscriptionRow = z.infer<typeof webPushSubscriptionRowSchema>;

export const webPushPayloadSchema = z
  .object({ runId: z.string(), workflowName: z.string(), kind: attentionNoticeKindSchema })
  .openapi('WebPushPayload');
export type WebPushPayload = z.infer<typeof webPushPayloadSchema>;
