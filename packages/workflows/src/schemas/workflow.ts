/**
 * Zod schemas for workflow definition types, plus result types for
 * workflow loading and execution (non-schema hand-written discriminated unions).
 */
import { z } from '@hono/zod-openapi';
import {
  dagNodeSchema,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
} from './dag-node';

// ---------------------------------------------------------------------------
// Shared enum schemas
// ---------------------------------------------------------------------------

export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

export const webSearchModeSchema = z.enum(['disabled', 'cached', 'live']);

export type WebSearchMode = z.infer<typeof webSearchModeSchema>;

// ---------------------------------------------------------------------------
// WorkflowBase — common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  provider: z.string().trim().min(1).optional(),
  model: z.string().optional(),
  modelReasoningEffort: modelReasoningEffortSchema.optional(),
  webSearchMode: webSearchModeSchema.optional(),
  additionalDirectories: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array").optional(),
  sandbox: sandboxSettingsSchema.optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// WorkflowDefinition — DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML.
 * All workflows use DAG-based execution with `nodes`.
 */
export const workflowDefinitionSchema = workflowBaseSchema.extend({
  nodes: z.array(dagNodeSchema),
});

/** Workflow definition with fully typed nodes (DagNode[]) derived from the schema. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & { prompt?: never };

// ---------------------------------------------------------------------------
// LoadCommandResult — discriminated union for command load outcomes
// ---------------------------------------------------------------------------

/**
 * Result of loading a command prompt - discriminated union for specific error handling
 *
 * On success, `content` is non-empty (enforced at load time in executor-shared.ts, not by the type).
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason: 'invalid_name' | 'empty_file' | 'not_found' | 'permission_denied' | 'read_error';
      message: string;
    };

// ---------------------------------------------------------------------------
// WorkflowExecutionResult — discriminated union for execution outcomes
// ---------------------------------------------------------------------------

/**
 * Result of workflow execution - allows callers to detect success/failure
 */
export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string; summary?: string }
  | { success: false; workflowRunId?: string; error: string }
  | { success: true; paused: true; workflowRunId: string };

// ---------------------------------------------------------------------------
// WorkflowLoadError / WorkflowLoadResult — workflow discovery results
// ---------------------------------------------------------------------------

/** Workflow origin — bundled default or project-defined. */
export type WorkflowSource = 'bundled' | 'project';

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: WorkflowDefinition;
  readonly source: WorkflowSource;
}

/**
 * Error encountered while loading a workflow file
 */
export interface WorkflowLoadError {
  readonly filename: string;
  readonly error: string;
  readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
}

/**
 * Result of workflow discovery - includes both successful loads and errors
 */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowWithSource[];
  readonly errors: readonly WorkflowLoadError[];
}
