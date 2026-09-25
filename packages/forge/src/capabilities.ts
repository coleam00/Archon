import { z } from 'zod';

export const eventActionCapabilitySchema = z.union([
  z.object({
    kind: z.literal('issue.lifecycle'),
    action: z.enum(['opened', 'edited', 'closed', 'reopened']),
  }),
  z.object({
    kind: z.literal('pr.lifecycle'),
    action: z.enum([
      'opened',
      'edited',
      'head_updated',
      'ready',
      'drafted',
      'closed',
      'reopened',
      'merged',
    ]),
  }),
  z.object({ kind: z.literal('label.changed'), action: z.enum(['added', 'removed']) }),
  z.object({
    kind: z.literal('check.changed'),
    action: z.literal('changed'),
    unitKind: z.enum(['check', 'commit_status']),
  }),
]);
export type EventActionCapability = z.infer<typeof eventActionCapabilitySchema>;

export const forgeSourceCapabilitiesSchema = z.object({
  events: z.array(eventActionCapabilitySchema),
});
export type ForgeSourceCapabilities = z.infer<typeof forgeSourceCapabilitiesSchema>;
