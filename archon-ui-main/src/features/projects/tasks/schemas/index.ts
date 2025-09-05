import { z } from "zod";

// Base validation schemas
export const DatabaseTaskStatusSchema = z.enum(["todo", "doing", "review", "done"]);
export const TaskPrioritySchema = z.enum(["low", "medium", "high", "critical"]);

// Assignee schema - simplified to predefined options
export const AssigneeSchema = z.enum(["User", "Archon", "AI IDE Agent"]);

// Task schemas
export const CreateTaskSchema = z.object({
  project_id: z.string().uuid("Project ID must be a valid UUID"),
  parent_task_id: z.string().uuid("Parent task ID must be a valid UUID").optional(),
  title: z.string().min(1, "Task title is required").max(255, "Task title must be less than 255 characters"),
  description: z.string().max(10000, "Task description must be less than 10000 characters").default(""),
  status: DatabaseTaskStatusSchema.default("todo"),
  assignee: AssigneeSchema.default("User"),
  task_order: z.number().int().min(0).default(0),
  feature: z.string().max(100, "Feature name must be less than 100 characters").optional(),
  featureColor: z
    .string()
    .regex(/^#[0-9A-F]{6}$/i, "Feature color must be a valid hex color")
    .optional(),
  priority: TaskPrioritySchema.default("medium"),
  sources: z.array(z.any()).default([]),
  code_examples: z.array(z.any()).default([]),
});

export const UpdateTaskSchema = CreateTaskSchema.partial().omit({
  project_id: true,
});

export const TaskSchema = z.object({
  id: z.string().uuid("Task ID must be a valid UUID"),
  project_id: z.string().uuid("Project ID must be a valid UUID"),
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
});

// Update task status schema (for drag & drop operations)
export const UpdateTaskStatusSchema = z.object({
  task_id: z.string().uuid("Task ID must be a valid UUID"),
  status: DatabaseTaskStatusSchema,
});

// Validation helper functions
export function validateTask(data: unknown) {
  return TaskSchema.safeParse(data);
}

export function validateCreateTask(data: unknown) {
  return CreateTaskSchema.safeParse(data);
}

export function validateUpdateTask(data: unknown) {
  return UpdateTaskSchema.safeParse(data);
}

export function validateUpdateTaskStatus(data: unknown) {
  return UpdateTaskStatusSchema.safeParse(data);
}

// Export type inference helpers
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusSchema>;
export type TaskInput = z.infer<typeof TaskSchema>;
