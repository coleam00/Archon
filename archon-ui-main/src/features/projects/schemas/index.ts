import { z } from "zod";

// Base validation schemas
export const ProjectColorSchema = z.enum(["cyan", "purple", "pink", "blue", "orange", "green"]);

// Project schemas
export const CreateProjectSchema = z.object({
  title: z.string().min(1, "Project title is required").max(255, "Project title must be less than 255 characters"),
  description: z.string().max(1000, "Description must be less than 1000 characters").optional(),
  icon: z.string().optional(),
  color: ProjectColorSchema.optional(),
  github_repo: z.string().url("GitHub repo must be a valid URL").optional(),
  prd: z.record(z.unknown()).optional(),
  docs: z.array(z.unknown()).optional(),
  features: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
  technical_sources: z.array(z.string()).optional(),
  business_sources: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

export const UpdateProjectSchema = CreateProjectSchema.partial();

export const ProjectSchema = z.object({
  id: z.string().uuid("Project ID must be a valid UUID"),
  title: z.string().min(1),
  prd: z.record(z.unknown()).optional(),
  docs: z.array(z.unknown()).optional(),
  features: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
  github_repo: z.string().url().optional().or(z.literal("")),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  technical_sources: z.array(z.unknown()).optional(), // Can be strings or full objects
  business_sources: z.array(z.unknown()).optional(), // Can be strings or full objects

  // Extended UI properties
  description: z.string().optional(),
  icon: z.string().optional(),
  color: ProjectColorSchema.optional(),
  progress: z.number().min(0).max(100).optional(),
  pinned: z.boolean(),
  updated: z.string().optional(), // Human-readable format
});

// Validation helper functions
export function validateProject(data: unknown) {
  return ProjectSchema.safeParse(data);
}

export function validateCreateProject(data: unknown) {
  return CreateProjectSchema.safeParse(data);
}

export function validateUpdateProject(data: unknown) {
  return UpdateProjectSchema.safeParse(data);
}

// Export type inference helpers
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
export type ProjectInput = z.infer<typeof ProjectSchema>;
