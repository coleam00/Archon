import { z } from '@hono/zod-openapi';
import { workflowSourceSchema } from './workflow.schemas';

export const webhookSlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/)
  .openapi('WebhookSlug');

export const webhookRuleSchema = z
  .object({
    id: z.string(),
    codebaseId: z.string(),
    codebaseName: z.string(),
    urlSlug: webhookSlugSchema,
    workflowName: z.string(),
    enabled: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('WebhookRule');

export const webhookRuleListResponseSchema = z
  .object({
    rules: z.array(webhookRuleSchema),
  })
  .openapi('WebhookRuleListResponse');

export const webhookRuleBodySchema = z
  .object({
    codebaseId: z.string(),
    urlSlug: webhookSlugSchema,
    workflowName: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .openapi('CreateWebhookRuleBody');

export const webhookRuleUpdateBodySchema = z
  .object({
    codebaseId: z.string().optional(),
    urlSlug: webhookSlugSchema.optional(),
    workflowName: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi('UpdateWebhookRuleBody');

export const webhookRuleIdParamsSchema = z.object({ id: z.string() });

export const webhookRuleCodebaseOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .openapi('WebhookRuleCodebaseOption');

export const webhookWorkflowOptionSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    source: workflowSourceSchema,
  })
  .openapi('WebhookWorkflowOption');

export const webhookWorkflowsByCodebaseSchema = z
  .object({
    codebaseId: z.string(),
    workflows: z.array(webhookWorkflowOptionSchema),
  })
  .openapi('WebhookWorkflowsByCodebase');

export const webhookRuleOptionsResponseSchema = z
  .object({
    codebases: z.array(webhookRuleCodebaseOptionSchema),
    workflowsByCodebase: z.array(webhookWorkflowsByCodebaseSchema),
  })
  .openapi('WebhookRuleOptionsResponse');

export const deleteWebhookRuleResponseSchema = z
  .object({
    success: z.boolean(),
  })
  .openapi('DeleteWebhookRuleResponse');
