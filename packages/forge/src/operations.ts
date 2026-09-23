import { z } from 'zod';
import { checkChangedEventSchema, type CheckResult } from './events';
import { gitObjectIdSchema, prRefSchema, repoRefSchema } from './identity';

export const checksStateSchema = z.enum(['none', 'pending', 'green', 'red', 'gated', 'unknown']);
export type ChecksState = z.infer<typeof checksStateSchema>;

/**
 * How a concluded check's result gates. `action_required` waits on a maintainer's
 * approval, so it is gated rather than red; `stale` and `startup_failure` are
 * terminal and never green. Plugins and the deliver pack's gh reader both
 * classify through this table so the sources agree.
 */
export const concludedCheckStates = {
  success: 'green',
  neutral: 'green',
  skipped: 'green',
  action_required: 'gated',
  failure: 'red',
  cancelled: 'red',
  timed_out: 'red',
  stale: 'red',
  startup_failure: 'red',
  unknown: 'unknown',
} as const satisfies Record<CheckResult, Exclude<ChecksState, 'none' | 'pending'>>;
export const checkObservationSchema = checkChangedEventSchema
  .pick({
    unit: true,
    nativeState: true,
    phase: true,
    nativeResult: true,
    result: true,
  })
  .extend({ state: checksStateSchema.exclude(['none']) });
export type CheckObservation = z.infer<typeof checkObservationSchema>;
export const checksSummarySchema = z.object({
  state: checksStateSchema,
  counts: z.object({
    total: z.number().int().nonnegative(),
    green: z.number().int().nonnegative(),
    red: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    gated: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
});
const checkSetSchema = z
  .object({ units: z.array(checkObservationSchema), summary: checksSummarySchema })
  .superRefine((value, ctx) => {
    const expected = summarizeChecks(value.units);
    if (
      value.summary.state !== expected.state ||
      Object.entries(expected.counts).some(
        ([key, count]) => value.summary.counts[key as keyof typeof expected.counts] !== count
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Check summary must match enumerated units',
        path: ['summary'],
      });
    }
  });
export const checksObservationSchema = checkSetSchema.safeExtend({
  ref: prRefSchema,
  revision: gitObjectIdSchema,
  required: checkSetSchema.nullable(),
});
export type ChecksObservation = z.infer<typeof checksObservationSchema>;
export const pluginIdentitySchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
});
export const pluginMetadataSchema = pluginIdentitySchema.extend({
  protocol: z.literal(1),
  forge: z.string().min(1),
  hosts: z.array(z.string().min(1)),
  capabilities: z.array(z.string().min(1)),
  token_env: z.array(z.string().min(1)).default([]),
});
export type PluginMetadata = z.infer<typeof pluginMetadataSchema>;
export const resolveResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none'), forge: z.literal('none') }),
  z.object({
    kind: z.literal('resolved'),
    forge: z.string().min(1),
    repo: repoRefSchema,
    plugin: pluginIdentitySchema,
  }),
]);
export const resolveRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('resolve'),
  remote: z.string().nullable(),
});
export const checksRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('checks.state'),
  ref: prRefSchema,
});
export const forgeRequestSchema = z.discriminatedUnion('op', [
  resolveRequestSchema,
  checksRequestSchema,
]);
export type ForgeRequest = z.infer<typeof forgeRequestSchema>;
export const forgeErrorSchema = z.object({
  kind: z.enum([
    'unsupported_op',
    'no_plugin_for_host',
    'no_credential',
    'not_found',
    'forge_error',
    'invalid_request',
    'invalid_response',
    'duplicate_host',
    'process_failed',
    'timeout',
  ]),
  message: z.string().min(1),
  status: z.number().int().optional(),
  exitCode: z.number().int().nullable().optional(),
});
export type ForgeError = z.infer<typeof forgeErrorSchema>;
const responseBase = z.object({ operationId: z.string().min(1) });
export const forgeResponseSchema = z.discriminatedUnion('ok', [
  responseBase.extend({
    ok: z.literal(true),
    result: z.discriminatedUnion('op', [
      z.object({ op: z.literal('resolve'), value: resolveResultSchema }),
      z.object({ op: z.literal('checks.state'), value: checksObservationSchema }),
    ]),
  }),
  responseBase.extend({ ok: z.literal(false), error: forgeErrorSchema }),
]);
export type ForgeResponse = z.infer<typeof forgeResponseSchema>;
export const forgeOperationAuditSchema = z.object({
  operationId: z.string().min(1),
  operation: z.union([resolveRequestSchema.shape.op, checksRequestSchema.shape.op]),
  target: z.union([prRefSchema, repoRefSchema]).nullable(),
  plugin: pluginIdentitySchema.nullable(),
  result: forgeResponseSchema,
  durationMs: z.number().nonnegative(),
});

export function summarizeChecks(
  units: readonly CheckObservation[]
): z.infer<typeof checksSummarySchema> {
  const counts = { total: units.length, green: 0, red: 0, pending: 0, gated: 0, unknown: 0 };
  for (const unit of units) counts[unit.state]++;
  const state =
    (['red', 'gated', 'unknown', 'pending', 'green'] as const).find(value => counts[value] > 0) ??
    'none';
  return { state, counts };
}
