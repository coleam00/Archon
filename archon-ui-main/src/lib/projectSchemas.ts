import { z } from 'zod';

// Base validation schemas
export const DatabaseTaskStatusSchema = z.enum(['todo', 'doing', 'review', 'done']);
// Using database status values directly - no UI mapping needed
export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const ProjectColorSchema = z.enum(['cyan', 'purple', 'pink', 'blue', 'orange', 'green']);

// Assignee schema - simplified to predefined options
export const AssigneeSchema = z.enum(['User', 'Archon', 'AI IDE Agent']);

// Project schemas
export const CreateProjectSchema = z.object({
  title: z.string()
    .min(1, 'Project title is required')
    .max(255, 'Project title must be less than 255 characters'),
  description: z.string()
    .max(1000, 'Description must be less than 1000 characters')
    .optional(),
  icon: z.string().optional(),
  color: ProjectColorSchema.optional(),
  github_repo: z.string()
    .url('GitHub repo must be a valid URL')
    .optional(),
  prd: z.record(z.any()).optional(),
  docs: z.array(z.any()).optional(),
  features: z.array(z.any()).optional(),
  data: z.array(z.any()).optional(),
  technical_sources: z.array(z.string()).optional(),
  business_sources: z.array(z.string()).optional(),
  pinned: z.boolean().optional()
});

export const UpdateProjectSchema = CreateProjectSchema.partial();

export const ProjectSchema = z.object({
  id: z.string().uuid('Project ID must be a valid UUID'),
  title: z.string().min(1),
  prd: z.record(z.any()).optional(),
  docs: z.array(z.any()).optional(),
  features: z.array(z.any()).optional(),
  data: z.array(z.any()).optional(),
  github_repo: z.string().url().optional().or(z.literal('')),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  technical_sources: z.array(z.any()).optional(), // Can be strings or full objects
  business_sources: z.array(z.any()).optional(), // Can be strings or full objects
  
  // Extended UI properties
  description: z.string().optional(),
  icon: z.string().optional(),
  color: ProjectColorSchema.optional(),
  progress: z.number().min(0).max(100).optional(),
  pinned: z.boolean(),
  updated: z.string().optional() // Human-readable format
});

// Task schemas  
export const CreateTaskSchema = z.object({
  project_id: z.string().uuid('Project ID must be a valid UUID'),
  parent_task_id: z.string().uuid('Parent task ID must be a valid UUID').optional(),
  title: z.string()
    .min(1, 'Task title is required')
    .max(255, 'Task title must be less than 255 characters'),
  description: z.string()
    .max(10000, 'Task description must be less than 10000 characters')
    .default(''),
  status: DatabaseTaskStatusSchema.default('todo'),
  assignee: AssigneeSchema.default('User'),
  task_order: z.number().int().min(0).default(0),
  feature: z.string()
    .max(100, 'Feature name must be less than 100 characters')
    .optional(),
  featureColor: z.string()
    .regex(/^#[0-9A-F]{6}$/i, 'Feature color must be a valid hex color')
    .optional(),
  priority: TaskPrioritySchema.default('medium'),
  sources: z.array(z.any()).default([]),
  code_examples: z.array(z.any()).default([])
});

export const UpdateTaskSchema = CreateTaskSchema.partial().omit({ project_id: true });

export const TaskSchema = z.object({
  id: z.string().uuid('Task ID must be a valid UUID'),
  project_id: z.string().uuid('Project ID must be a valid UUID'),
  parent_task_id: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string(),
  status: DatabaseTaskStatusSchema,
  assignee: AssigneeSchema,
  task_order: z.number().int().min(0),
  sources: z.array(z.any()).default([]),
  code_examples: z.array(z.any()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  
  // Extended UI properties
  feature: z.string().optional(),
  featureColor: z.string().optional(),
  priority: TaskPrioritySchema.optional(),
  // No UI-specific status mapping needed
});

// Update task status schema (for drag & drop operations)
export const UpdateTaskStatusSchema = z.object({
  task_id: z.string().uuid('Task ID must be a valid UUID'),
  status: DatabaseTaskStatusSchema
});

// MCP tool response schema
export const MCPToolResponseSchema = z.object({
  success: z.boolean(),
  data: z.any().optional(),
  error: z.string().optional(),
  message: z.string().optional()
});

// Paginated response schema
export const PaginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().min(0),
    page: z.number().min(1),
    limit: z.number().min(1),
    hasMore: z.boolean()
  });

// Validation helper functions
export function validateProject(data: unknown) {
  return ProjectSchema.safeParse(data);
}

export function validateTask(data: unknown) {
  return TaskSchema.safeParse(data);
}

export function validateCreateProject(data: unknown) {
  return CreateProjectSchema.safeParse(data);
}

export function validateCreateTask(data: unknown) {
  return CreateTaskSchema.safeParse(data);
}

export function validateUpdateProject(data: unknown) {
  return UpdateProjectSchema.safeParse(data);
}

export function validateUpdateTask(data: unknown) {
  return UpdateTaskSchema.safeParse(data);
}

export function validateUpdateTaskStatus(data: unknown) {
  return UpdateTaskStatusSchema.safeParse(data);
}

// Helper function to format validation errors
export function formatValidationErrors(errors: z.ZodError): string {
  return errors.errors
    .map(error => `${error.path.join('.')}: ${error.message}`)
    .join(', ');
}

// Export type inference helpers
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusSchema>;
export type ProjectInput = z.infer<typeof ProjectSchema>;
export type TaskInput = z.infer<typeof TaskSchema>; 