import { z } from 'zod';
import { repoRefSchema } from './identity';
import { forgeResponseSchema, pluginIdentitySchema, pluginMetadataSchema } from './operations';

export const cliForgeMetadataRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('metadata'),
  host: z.string().trim().min(1),
});

/**
 * `forge check`: the capabilities a workflow will call, asked before it spends. The forge
 * is named by `host`, by a git `remote` whose plugin is selected as a `resolve` of that
 * remote selects one, or by a `repo`. The three are exclusive alternatives, so the
 * exported contract and the declaration generated from it refuse a request that names
 * more than one or none. A `remote` or `repo` check also reads that repository.
 */
const checkRequestBase = z.object({
  operationId: z.string().min(1),
  op: z.literal('check'),
  operations: z.array(z.string().min(1)),
});
const forgeNamedOnce = 'name the forge by exactly one of host, remote or repo';
const forgeName = z
  .string({ error: issue => (issue.input === undefined ? forgeNamedOnce : undefined) })
  .trim()
  .min(1);
const notAlso = z.never({ error: forgeNamedOnce }).optional();
export const cliForgeCheckRequestSchema = z.union([
  checkRequestBase.extend({ host: forgeName, remote: notAlso, repo: notAlso }),
  checkRequestBase.extend({ remote: forgeName, host: notAlso, repo: notAlso }),
  checkRequestBase.extend({ repo: repoRefSchema, host: notAlso, remote: notAlso }),
]);
const cliForgeCheckSchema = z.object({
  host: z.string().min(1),
  plugin: pluginIdentitySchema,
  operations: z.array(z.string().min(1)),
  // Where the credential was found, never the credential. Absent when the plugin needs none.
  credentialSource: z.string().min(1).optional(),
});

const [success, failure] = forgeResponseSchema.options;
const credential = { credentialSource: z.string().min(1).optional() };

/**
 * What the host recorded on the run's item for a `pr.merge` from a run on an item: on the
 * success response for an applied merge, and on the refusal of a pull request the forge
 * reports already merged. `no_merge_time`: the forge reported no merge time, so nothing
 * was recorded. `already_recorded`: the item already had its merge and landing, or a merge
 * of another change, so nothing was written. `write_failed`: the store refused the write,
 * and the command exits 2 with the reason on stderr. The merge itself happened either way.
 * Absent for every other operation and outcome, and for a run on no item.
 */
export const cliForgeItemRecordSchema = z.discriminatedUnion('recorded', [
  z.object({ recorded: z.literal(true) }),
  z.object({
    recorded: z.literal(false),
    reason: z.enum(['no_merge_time', 'already_recorded', 'write_failed']),
  }),
]);
export type CliForgeItemRecord = z.infer<typeof cliForgeItemRecordSchema>;

/** CLI host additions; the executable plugin protocol remains forgeResponseSchema. */
export const cliForgeResponseSchema = z.discriminatedUnion('ok', [
  success.extend({
    ...credential,
    itemRecord: cliForgeItemRecordSchema.optional(),
    result: z.union([
      success.shape.result,
      z.object({ op: z.literal('metadata'), value: pluginMetadataSchema }),
      z.object({ op: z.literal('check'), value: cliForgeCheckSchema }),
    ]),
  }),
  failure.extend({
    ...credential,
    itemRecord: cliForgeItemRecordSchema.optional(),
    // `forge check` only: the named capabilities the plugin does not advertise, and the
    // operator's next step, from the plugin when it states one.
    unsupported: z.array(z.string().min(1)).optional(),
    remedy: z.string().min(1).optional(),
  }),
]);
export type CliForgeResponse = z.infer<typeof cliForgeResponseSchema>;
