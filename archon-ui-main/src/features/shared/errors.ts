/**
 * Shared Error Classes and Utilities
 * Common error handling across all features
 */

/**
 * Base API error class for all service errors
 */
export class APIServiceError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "APIServiceError";
  }
}

/**
 * Validation error for input validation failures
 */
export class ValidationError extends APIServiceError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

/**
 * MCP Tool error for Model Context Protocol operations
 */
export class MCPToolError extends APIServiceError {
  constructor(
    message: string,
    public toolName: string,
  ) {
    super(message, "MCP_TOOL_ERROR", 500);
    this.name = "MCPToolError";
  }
}

/**
 * Helper types for validation error formatting
 */
interface ValidationErrorDetail {
  path: string[];
  message: string;
}

interface ValidationErrorObject {
  errors: ValidationErrorDetail[];
}

/**
 * Format validation errors into a readable string
 */
export function formatValidationErrors(errors: ValidationErrorObject): string {
  return errors.errors.map((error: ValidationErrorDetail) => `${error.path.join(".")}: ${error.message}`).join(", ");
}

/**
 * Convert Zod validation errors to a formatted string
 */
export function formatZodErrors(zodError: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  const validationErrors: ValidationErrorObject = {
    errors: zodError.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    })),
  };
  return formatValidationErrors(validationErrors);
}
