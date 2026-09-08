import { z } from 'zod';
// All public vocabulary and wire shapes derive from this leaf module.
export const repoRefSchema = z.object({
  host: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  path: z
    .string()
    .regex(/^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+$/u)
    .refine(value => value.split('/').every(part => part !== '.' && part !== '..')),
});
export type RepoRef = z.infer<typeof repoRefSchema>;
export const prRefSchema = z.object({ repo: repoRefSchema, number: z.number().int().positive() });
export type PrRef = z.infer<typeof prRefSchema>;
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const checksStateSchema = z.enum(['none', 'pending', 'green', 'red', 'gated', 'unknown']);
export type ChecksState = z.infer<typeof checksStateSchema>;
export const CHECKS = checksStateSchema.enum;
export const unitStateSchema = checksStateSchema.exclude(['none']);
// Object.fromEntries loses the literal key union; the mapped type restores exactly its input keys.
export const checksCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  ...Object.fromEntries(
    unitStateSchema.options.map(state => [state, z.number().int().nonnegative()])
  ),
}) as z.ZodObject<{ total: z.ZodNumber } & Record<z.infer<typeof unitStateSchema>, z.ZodNumber>>;
export type ChecksCounts = z.infer<typeof checksCountsSchema>;
export const checkUnitSourceSchema = z.enum(['check-run', 'status', 'native']);
export type CheckUnitSource = z.infer<typeof checkUnitSourceSchema>;
export const checkUnitSummarySchema = z.object({
  name: z.string(),
  source: checkUnitSourceSchema,
  state: unitStateSchema,
});
export const CHECKS_VERDICT_UNITS_CAP = 100;
export function aggregateChecks(counts: ChecksCounts): ChecksState {
  if (counts.total === 0) return CHECKS.none;
  return (
    [CHECKS.red, CHECKS.gated, CHECKS.unknown, CHECKS.pending, CHECKS.green].find(
      state => counts[state] > 0
    ) ?? CHECKS.unknown
  );
}
export function emptyCounts(): ChecksCounts {
  return checksCountsSchema.parse(
    Object.fromEntries(['total', ...unitStateSchema.options].map(key => [key, 0]))
  );
}
const summarySchema = z.object({ state: checksStateSchema, counts: checksCountsSchema });
function consistentSummary(value: z.infer<typeof summarySchema>): boolean {
  return (
    value.counts.total ===
      unitStateSchema.options.reduce((sum, state) => sum + value.counts[state], 0) &&
    value.state === aggregateChecks(value.counts)
  );
}
export const checksVerdictSchema = summarySchema
  .extend({
    units: z.array(checkUnitSummarySchema).max(CHECKS_VERDICT_UNITS_CAP),
    required: summarySchema.refine(consistentSummary, 'counts and state disagree').optional(),
    head_sha: shaSchema,
  })
  .refine(consistentSummary, 'counts and state disagree')
  .refine(value => {
    if (value.units.length !== Math.min(value.counts.total, CHECKS_VERDICT_UNITS_CAP)) return false;
    return unitStateSchema.options.every(
      state => value.units.filter(unit => unit.state === state).length <= value.counts[state]
    );
  }, 'unit summaries and counts disagree');
export type ChecksVerdict = z.infer<typeof checksVerdictSchema>;
export const forgeOpErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported_op'), op: z.string(), plugin: z.string().optional() }),
  z.object({ kind: z.literal('no_plugin_for_host'), host: z.string() }),
  z.object({
    kind: z.literal('no_credential'),
    host: z.string(),
    token_env: z.string().optional(),
  }),
  z.object({ kind: z.literal('not_found'), target: z.string() }),
  z.object({
    kind: z.literal('verify_failed'),
    expected: z.string(),
    observed: z.string(),
    leave_behind: z.string().optional(),
  }),
  z.object({
    kind: z.literal('forge_error'),
    status: z.number().int().optional(),
    evidence: z.string(),
  }),
  z.object({ kind: z.literal('invalid_request'), detail: z.string() }),
  z.object({ kind: z.literal('invalid_response'), detail: z.string() }),
]);
export type ForgeOpError = z.infer<typeof forgeOpErrorSchema>;
export const forgeOpErrorKindSchema = z.enum(
  forgeOpErrorSchema.options.map(option => option.shape.kind.value)
);
export type ForgeOpErrorKind = z.infer<typeof forgeOpErrorKindSchema>;
export const FORGE_PROTOCOL_VERSION = 1;
export const pluginMetadataSchema = z.object({
  protocol: z.number().int().positive(),
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  forge: z
    .string()
    .min(1)
    .refine(value => value !== 'none'),
  hosts: z.array(repoRefSchema.shape.host),
  capabilities: z.array(z.string().min(1)),
  token_env: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
});
export type PluginMetadata = z.infer<typeof pluginMetadataSchema>;
export const forgeProcessFailureSchema = z.object({
  kind: z.literal('process_failure'),
  detail: z.string(),
  plugin: pluginMetadataSchema.pick({ name: true, version: true }).optional(),
});
export type ForgeProcessFailure = z.infer<typeof forgeProcessFailureSchema>;
// resolve is the protocol's root operation; forge operations use dotted names.
export const RESOLVE_OP = 'resolve';
export const CHECKS_STATE_OP = 'checks.state';
export const resolveRequestSchema = z.object({ repo: repoRefSchema });
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;
export const resolveResultSchema = z
  .object({
    forge: z.string(),
    repo: repoRefSchema.optional(),
    plugin: pluginMetadataSchema.pick({ name: true, version: true }).optional(),
  })
  .refine(
    value => value.forge === 'none' || (value.repo !== undefined && value.plugin !== undefined),
    'a resolved forge needs a qualified repository and plugin'
  );
export type ResolveResult = z.infer<typeof resolveResultSchema>;
export const checksStateRequestSchema = z.object({ ref: prRefSchema });
export type ChecksStateRequest = z.infer<typeof checksStateRequestSchema>;
export const checksStateResultSchema = checksVerdictSchema;
export type ChecksStateResult = ChecksVerdict;
export const forgeHostsConfigSchema = z.record(
  repoRefSchema.shape.host,
  z.object({
    plugin: pluginMetadataSchema.shape.name,
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    token_env: pluginMetadataSchema.shape.token_env,
  })
);
export type ForgeHostsConfig = z.infer<typeof forgeHostsConfigSchema>;
export const forgeOpAuditEventSchema = z.object({
  op: z.string(),
  target: z.string(),
  plugin: pluginMetadataSchema.pick({ name: true, version: true }).optional(),
  outcome: z.union([z.literal('ok'), z.literal('process_failure'), forgeOpErrorKindSchema]),
  duration_ms: z.number().int().nonnegative(),
});
export type ForgeOpAuditEvent = z.infer<typeof forgeOpAuditEventSchema>;
