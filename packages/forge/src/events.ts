import { z } from 'zod';
import {
  forgeSubjectRefSchema,
  gitObjectIdSchema,
  prRefSchema,
  repoRefSchema,
  sourceActorSchema,
  workItemRefSchema,
} from './identity';

export const issueLifecycleEventSchema = z.object({
  kind: z.literal('issue.lifecycle'),
  action: z.enum(['opened', 'edited', 'closed', 'reopened']),
  issue: workItemRefSchema,
  state: z.enum(['open', 'closed']).nullable(),
});

const revisionSchema = z.object({
  objectId: gitObjectIdSchema,
  branch: z.string().min(1).nullable(),
});

export const prLifecycleEventSchema = z.object({
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
  pr: prRefSchema,
  state: z.enum(['open', 'closed']).nullable(),
  draft: z.boolean().nullable(),
  head: revisionSchema.nullable(),
  base: revisionSchema.nullable(),
});

export const labelChangedEventSchema = z.object({
  kind: z.literal('label.changed'),
  action: z.enum(['added', 'removed']),
  subject: forgeSubjectRefSchema,
  label: z.object({ name: z.string().min(1), id: z.string().min(1).nullable() }),
});

export const checkResultSchema = z.enum([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
  'unknown',
]);
export type CheckResult = z.infer<typeof checkResultSchema>;

export const checkChangedEventSchema = z.object({
  kind: z.literal('check.changed'),
  action: z.literal('changed'),
  repo: repoRefSchema,
  revision: gitObjectIdSchema,
  unit: z.object({
    kind: z.enum(['check', 'commit_status']),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  nativeState: z.string().min(1),
  phase: z.enum(['pending', 'running', 'completed', 'unknown']),
  nativeResult: z.string().min(1).nullable(),
  result: checkResultSchema.nullable(),
  pullRequests: z.array(prRefSchema),
});

export const forgeEventSchema = z.discriminatedUnion('kind', [
  issueLifecycleEventSchema,
  prLifecycleEventSchema,
  labelChangedEventSchema,
  checkChangedEventSchema,
]);
export type ForgeEvent = z.infer<typeof forgeEventSchema>;

export const forgeEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  sourceInstanceId: z.string().min(1),
  deliveryId: z.string().min(1).nullable(),
  contentDigest: z.string().min(1),
  receivedAt: z.iso.datetime({ offset: true }),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  sourceActor: sourceActorSchema.nullable().optional(),
  event: forgeEventSchema,
});
export type ForgeEventEnvelope = z.infer<typeof forgeEventEnvelopeSchema>;
