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

/** CLI host additions; the executable plugin protocol remains forgeResponseSchema. */
export const cliForgeResponseSchema = z.discriminatedUnion('ok', [
  success.extend({
    ...credential,
    result: z.union([
      success.shape.result,
      z.object({ op: z.literal('metadata'), value: pluginMetadataSchema }),
      z.object({ op: z.literal('check'), value: cliForgeCheckSchema }),
    ]),
  }),
  failure.extend({
    ...credential,
    // `forge check` only: the named capabilities the plugin does not advertise, and the
    // operator's next step, from the plugin when it states one.
    unsupported: z.array(z.string().min(1)).optional(),
    remedy: z.string().min(1).optional(),
  }),
]);
export type CliForgeResponse = z.infer<typeof cliForgeResponseSchema>;
