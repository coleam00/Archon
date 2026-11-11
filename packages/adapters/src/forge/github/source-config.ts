/**
 * The GitHub source plugin's configuration schema, apart from the plugin so that a reader
 * that must not bundle the plugin (the CLI's `pack bindings`) checks a binding against the
 * plugin's own schema rather than a copy of it.
 */
import { isAbsolute } from 'node:path';
import { z } from '@hono/zod-openapi';
import {
  createForgeInputBindingSchema,
  createForgeBindingSchema,
  forgeEventSelectorSchema,
} from '@archon/forge';
import { jsonValueSchema } from '@archon/workflows/output-ref';
import { resourceStartBindingIntentSchema } from '@archon/workflows/schemas/resource-start';

export const githubSourceBindingSchema = resourceStartBindingIntentSchema
  .omit({ bindingRevision: true, eventInputs: true })
  .extend({
    selector: forgeEventSelectorSchema,
    inputMapping: z.record(z.string(), createForgeInputBindingSchema(jsonValueSchema)),
  });

export const githubWebhookSourceConfigSchema = z
  .object({
    version: z.literal(1),
    webhookSecretEnv: z.string().min(1),
    host: z.literal('github.com'),
    bindings: z.array(githubSourceBindingSchema),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<string>();
    const mappingSchema = createForgeBindingSchema(jsonValueSchema);
    for (const [index, binding] of config.bindings.entries()) {
      if (seen.has(binding.bindingId))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'bindingId'],
          message: 'Duplicate binding ID',
        });
      seen.add(binding.bindingId);
      const mapping = mappingSchema.safeParse({
        selector: binding.selector,
        inputs: binding.inputMapping,
      });
      if (!mapping.success)
        for (const issue of mapping.error.issues)
          context.addIssue({
            code: 'custom',
            path: ['bindings', index, ...issue.path],
            message: issue.message,
          });
      if (!isAbsolute(binding.launch.cwd))
        context.addIssue({
          code: 'custom',
          path: ['bindings', index, 'launch', 'cwd'],
          message: 'Expected an absolute execution path',
        });
    }
  });
