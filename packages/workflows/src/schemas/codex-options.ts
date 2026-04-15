import { z } from '@hono/zod-openapi';

// Shared Codex enum schemas reused by workflow and node parsing.
export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const webSearchModeSchema = z.enum(['disabled', 'cached', 'live']);

export type WebSearchMode = z.infer<typeof webSearchModeSchema>;
