import { z } from '@hono/zod-openapi';
import { workflowRunConfigLayerSchema } from '@archon/workflows/schemas/run-config';
import { MAX_FILES_PER_MESSAGE, MAX_UPLOAD_BYTES } from '../api-message-dispatch';
import { tierFields } from './config.schemas';

// HTTP accepts raw config spellings; the core parser owns their normalization and
// provider-registry validation. Reuse the engine's nested structural constraints.
export const workflowRunLaunchConfigSchema = workflowRunConfigLayerSchema
  .omit({ docsPath: true, envVars: true })
  .extend({
    defaultAssistant: workflowRunConfigLayerSchema.shape.assistant,
    docs: z.object({ path: workflowRunConfigLayerSchema.shape.docsPath }).strict().optional(),
    env: workflowRunConfigLayerSchema.shape.envVars,
  })
  .openapi('WorkflowRunLaunchConfig', {
    description:
      'Sparse raw run configuration. Use assistant or defaultAssistant, never both. Provider names, model presets and assistants settings are validated against the live provider registry.',
    not: { required: ['assistant', 'defaultAssistant'] },
  });

const modelSpecSchema = z.string().trim().min(1);
const sharedLaunchSchema = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1),
  inputs: z.record(z.string(), z.string()).nullable().optional(),
  tiers: z.object(tierFields(modelSpecSchema.optional())).strict().nullable().optional(),
  aliases: z.record(z.string().regex(/^@/), modelSpecSchema).nullable().optional(),
  config: workflowRunLaunchConfigSchema.optional(),
});

export const workflowRunLaunchJsonSchema = sharedLaunchSchema
  .extend({
    adopt_run_id: z.string().min(1).optional(),
    supersedes_run_id: z.string().min(1).optional(),
  })
  .openapi('WorkflowRunLaunchJson', {
    description: 'Launch a workflow. adopt_run_id and supersedes_run_id are mutually exclusive.',
    not: { required: ['adopt_run_id', 'supersedes_run_id'] },
  });

export const workflowRunLaunchMultipartSchema = sharedLaunchSchema
  .extend({
    conversationId: sharedLaunchSchema.shape.conversationId.regex(/^[\w-]+$/),
    inputs: z
      .string()
      .optional()
      .openapi({ description: 'JSON encoding of WorkflowRunLaunchJson.inputs.' }),
    tiers: z
      .string()
      .optional()
      .openapi({ description: 'JSON encoding of WorkflowRunLaunchJson.tiers.' }),
    aliases: z
      .string()
      .optional()
      .openapi({ description: 'JSON encoding of WorkflowRunLaunchJson.aliases.' }),
    config: z
      .string()
      .optional()
      .openapi({ description: 'JSON encoding of WorkflowRunLaunchConfig.' }),
    files: z
      .array(z.string().openapi({ format: 'binary' }))
      .max(MAX_FILES_PER_MESSAGE)
      .optional()
      .openapi({
        description: `Repeated files parts, each at most ${MAX_UPLOAD_BYTES} bytes. Upload MIME type restrictions apply.`,
      }),
  })
  .openapi('WorkflowRunLaunchMultipart');
