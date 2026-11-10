import { z } from 'zod';
import { forgeResponseSchema, pluginIdentitySchema, pluginMetadataSchema } from './operations';

export const cliForgeMetadataRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('metadata'),
  host: z.string().trim().min(1),
});

/** `forge check`: the capabilities a workflow will call on `host`, asked before it spends. */
export const cliForgeCheckRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('check'),
  host: z.string().trim().min(1),
  operations: z.array(z.string().min(1)),
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
    // `forge check` only: the named capabilities the plugin does not advertise.
    unsupported: z.array(z.string().min(1)).optional(),
  }),
]);
export type CliForgeResponse = z.infer<typeof cliForgeResponseSchema>;
