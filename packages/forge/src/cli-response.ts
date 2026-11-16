import { z } from 'zod';
import { forgeResponseSchema, pluginIdentitySchema, pluginMetadataSchema } from './operations';

export const cliForgeMetadataRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('metadata'),
  host: z.string().trim().min(1),
});

/**
 * `forge check`: the capabilities a workflow will call, asked before it spends. The forge
 * is named by `host`, or by a git `remote` whose plugin is selected as a `resolve` of that
 * remote selects one.
 */
export const cliForgeCheckRequestSchema = z
  .object({
    operationId: z.string().min(1),
    op: z.literal('check'),
    host: z.string().trim().min(1).optional(),
    remote: z.string().trim().min(1).optional(),
    operations: z.array(z.string().min(1)),
  })
  .refine(request => (request.host === undefined) !== (request.remote === undefined), {
    message: 'name the forge by exactly one of host or remote',
  });
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
