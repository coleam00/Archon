import { z } from 'zod';
import {
  checkChangedEventSchema,
  commentChangedEventSchema,
  issueLifecycleEventSchema,
  labelChangedEventSchema,
  prLifecycleEventSchema,
} from './events';

export const eventActionCapabilitySchema = z.union([
  issueLifecycleEventSchema.pick({ kind: true, action: true }),
  prLifecycleEventSchema.pick({ kind: true, action: true }),
  labelChangedEventSchema.pick({ kind: true, action: true }),
  commentChangedEventSchema.pick({ kind: true, action: true }),
  checkChangedEventSchema
    .pick({ kind: true, action: true })
    .extend({ unitKind: checkChangedEventSchema.shape.unit.shape.kind }),
]);
export type EventActionCapability = z.infer<typeof eventActionCapabilitySchema>;

export const forgeSourceCapabilitiesSchema = z.object({
  events: z.array(eventActionCapabilitySchema),
});
export type ForgeSourceCapabilities = z.infer<typeof forgeSourceCapabilitiesSchema>;
