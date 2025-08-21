/**
 * Zod schemas for runtime validation of project-related data
 * These schemas ensure type safety when receiving data from the backend
 */

import { z } from 'zod';

/**
 * Schema for project document in JSONB field
 */
export const ProjectDocumentSchema = z.object({
  type: z.literal('document'),
  id: z.string(),
  title: z.string(),
  content: z.string(),
  metadata: z.record(z.unknown()),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * Schema for project feature in JSONB field
 */
export const ProjectFeatureSchema = z.object({
  type: z.literal('feature'),
  id: z.string(),
  name: z.string(),
  status: z.enum(['planned', 'in-progress', 'completed']),
  description: z.string(),
  priority: z.number().optional(),
  assignee: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

/**
 * Schema for project data in JSONB field
 */
export const ProjectDataSchema = z.object({
  type: z.literal('data'),
  key: z.string(),
  value: z.unknown(),
  timestamp: z.string(),
  source: z.string().optional(),
});

/**
 * Schema for task source references
 */
export const TaskSourceSchema = z.object({
  url: z.string().optional(),
  file: z.string().optional(),
  type: z.enum(['documentation', 'code', 'internal_docs', 'external']),
  relevance: z.string().optional(),
  title: z.string().optional(),
});

/**
 * Schema for task code examples
 */
export const TaskCodeExampleSchema = z.object({
  file: z.string(),
  function: z.string().optional(),
  class: z.string().optional(),
  purpose: z.string(),
  language: z.string().optional(),
  snippet: z.string().optional(),
});

/**
 * Schema for creation progress tracking
 */
export const CreationProgressSchema = z.object({
  progressId: z.string(),
  status: z.enum([
    'starting',
    'initializing_agents',
    'generating_docs',
    'processing_requirements',
    'ai_generation',
    'finalizing_docs',
    'saving_to_database',
    'completed',
    'error'
  ]),
  percentage: z.number(),
  logs: z.array(z.string()),
  error: z.string().optional(),
  step: z.string().optional(),
  currentStep: z.string().optional(),
  eta: z.string().optional(),
  duration: z.string().optional(),
  project: z.lazy(() => ProjectSchema).optional(),
});

/**
 * Main Project schema
 */
export const ProjectSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  prd: z.record(z.unknown()).optional(),
  docs: z.array(ProjectDocumentSchema).optional(),
  features: z.array(ProjectFeatureSchema).optional(),
  data: z.array(ProjectDataSchema).optional(),
  github_repo: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  technical_sources: z.array(z.string()).optional(),
  business_sources: z.array(z.string()).optional(),
  description: z.string().optional(),
  progress: z.number().optional(),
  updated: z.string().optional(),
  pinned: z.boolean(),
  creationProgress: CreationProgressSchema.optional(),
});

/**
 * Schema for Task
 */
export const TaskSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['todo', 'doing', 'review', 'done']),
  assignee: z.string(),
  task_order: z.number(),
  feature: z.string().optional(),
  sources: z.array(TaskSourceSchema).optional(),
  code_examples: z.array(TaskCodeExampleSchema).optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

/**
 * Schema for Create Task DTO
 */
export const CreateTaskDtoSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['todo', 'doing', 'review', 'done']).default('todo'),
  assignee: z.string().default('User'),
  task_order: z.number().optional(),
  feature: z.string().optional(),
  sources: z.array(TaskSourceSchema).optional(),
  code_examples: z.array(TaskCodeExampleSchema).optional(),
});

/**
 * Schema for Update Task DTO
 */
export const UpdateTaskDtoSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['todo', 'doing', 'review', 'done']).optional(),
  assignee: z.string().optional(),
  task_order: z.number().optional(),
  feature: z.string().optional(),
  sources: z.array(TaskSourceSchema).optional(),
  code_examples: z.array(TaskCodeExampleSchema).optional(),
});

/**
 * Schema for task reorder data
 */
export const ReorderDataSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    task_order: z.number(),
  })),
  sourceIndex: z.number().optional(),
  destinationIndex: z.number().optional(),
});

/**
 * Type exports inferred from schemas
 */
export type Project = z.infer<typeof ProjectSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type CreateTaskDto = z.infer<typeof CreateTaskDtoSchema>;
export type UpdateTaskDto = z.infer<typeof UpdateTaskDtoSchema>;
export type ReorderData = z.infer<typeof ReorderDataSchema>;
export type CreationProgress = z.infer<typeof CreationProgressSchema>;

/**
 * Validation functions
 */
export function validateProject(data: unknown): Project {
  return ProjectSchema.parse(data);
}

export function safeParseProject(data: unknown): Project | null {
  const result = ProjectSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  console.error('Project validation failed:', result.error);
  return null;
}

export function validateTask(data: unknown): Task {
  return TaskSchema.parse(data);
}

export function safeParseTask(data: unknown): Task | null {
  const result = TaskSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  console.error('Task validation failed:', result.error);
  return null;
}