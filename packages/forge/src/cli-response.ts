import { z } from 'zod';
import { forgeResponseSchema, pluginMetadataSchema } from './operations';

export const cliForgeMetadataRequestSchema = z.object({
  operationId: z.string().min(1),
  op: z.literal('metadata'),
  host: z.string().trim().min(1),
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
    ]),
  }),
  failure.extend(credential),
]);
export type CliForgeResponse = z.infer<typeof cliForgeResponseSchema>;
