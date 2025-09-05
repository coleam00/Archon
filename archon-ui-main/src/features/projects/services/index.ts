/**
 * Project Services
 *
 * All API communication and business logic for the projects feature.
 * Replaces the monolithic src/services/projectService.ts with focused services.
 */

// Export shared utilities
export * from "../shared/api";
// Re-export other services for convenience
export { taskService } from "../tasks/services/taskService";
// Export project-specific services
export { projectService } from "./projectService";
