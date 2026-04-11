/**
 * Zod schemas for configuration API endpoints.
 */
import { z } from '@hono/zod-openapi';

/** Schema for the safe config subset returned to web clients (mirrors SafeConfig in config-types.ts). */
export const safeConfigSchema = z
  .object({
    botName: z.string(),
    assistant: z.enum(['claude', 'codex', 'pi']),
    assistants: z.object({
      claude: z.object({ model: z.string().optional() }),
      codex: z.object({
        model: z.string().optional(),
        modelReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
        webSearchMode: z.enum(['disabled', 'cached', 'live']).optional(),
      }),
      pi: z.object({ model: z.string().optional() }),
    }),
    streaming: z.object({
      telegram: z.enum(['stream', 'batch']),
      discord: z.enum(['stream', 'batch']),
      slack: z.enum(['stream', 'batch']),
      // github removed — never implemented; hardcoded 'batch' in GitHubAdapter
    }),
    concurrency: z.object({ maxConversations: z.number() }),
    defaults: z.object({
      copyDefaults: z.boolean(),
      loadDefaultCommands: z.boolean(),
      loadDefaultWorkflows: z.boolean(),
    }),
  })
  .openapi('SafeConfig');

/** Body for PATCH /api/config/assistants — all fields optional (partial update). */
export const updateAssistantConfigBodySchema = z
  .object({
    assistant: z.enum(['claude', 'codex', 'pi']).optional(),
    claude: z
      .object({
        model: z.string(),
      })
      .optional(),
    codex: z
      .object({
        model: z.string(),
        modelReasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
        webSearchMode: z.enum(['disabled', 'cached', 'live']).optional(),
      })
      .optional(),
    pi: z
      .object({
        model: z.string(),
      })
      .optional(),
  })
  .openapi('UpdateAssistantConfigBody');

/** Response for GET /api/config and PATCH /api/config/assistants — returns updated safe config. */
export const configResponseSchema = z
  .object({
    config: safeConfigSchema,
    database: z.string(),
  })
  .openapi('ConfigResponse');

/** @deprecated Use configResponseSchema instead. */
export const updateAssistantConfigResponseSchema = configResponseSchema;

/** A single isolation environment record. */
export const isolationEnvironmentSchema = z
  .object({
    id: z.string(),
    codebase_id: z.string(),
    branch_name: z.string(),
    working_path: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    days_since_activity: z.number(),
  })
  .openapi('IsolationEnvironment');

/** Response for GET /api/codebases/:id/environments. */
export const codebaseEnvironmentsResponseSchema = z
  .object({
    environments: z.array(isolationEnvironmentSchema),
  })
  .openapi('CodebaseEnvironmentsResponse');
