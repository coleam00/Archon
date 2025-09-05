/**
 * Shared API utilities for project features
 * Common error handling and API calling functions
 */

// API configuration - use relative URL to go through Vite proxy
const API_BASE_URL = "/api";

// Error classes
export class ProjectServiceError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "ProjectServiceError";
  }
}

export class ValidationError extends ProjectServiceError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class MCPToolError extends ProjectServiceError {
  constructor(
    message: string,
    public toolName: string,
  ) {
    super(message, "MCP_TOOL_ERROR", 500);
    this.name = "MCPToolError";
  }
}

// Helper function to format validation errors
interface ValidationErrorDetail {
  path: string[];
  message: string;
}

interface ValidationErrorObject {
  errors: ValidationErrorDetail[];
}

export function formatValidationErrors(errors: ValidationErrorObject): string {
  return errors.errors.map((error: ValidationErrorDetail) => `${error.path.join(".")}: ${error.message}`).join(", ");
}

// Helper to convert Zod errors to ValidationErrorObject format
export function formatZodErrors(zodError: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  const validationErrors: ValidationErrorObject = {
    errors: zodError.issues.map((issue) => ({
      path: issue.path.map(String),
      message: issue.message,
    })),
  };
  return formatValidationErrors(validationErrors);
}

// Helper function to call FastAPI endpoints directly
export async function callAPI<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
  try {
    // Remove /api prefix if it exists since API_BASE_URL already includes it
    const cleanEndpoint = endpoint.startsWith("/api") ? endpoint.substring(4) : endpoint;
    const response = await fetch(`${API_BASE_URL}${cleanEndpoint}`, {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      // Try to get error details from response body
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorBody = await response.text();
        if (errorBody) {
          const errorJson = JSON.parse(errorBody);
          errorMessage = errorJson.detail || errorJson.error || errorMessage;
        }
      } catch (_e) {
        // Ignore parse errors, use default message
      }

      throw new ProjectServiceError(errorMessage, "HTTP_ERROR", response.status);
    }

    // Handle 204 No Content responses (common for DELETE operations)
    if (response.status === 204) {
      return undefined as T;
    }

    const result = await response.json();

    // Check if response has error field (from FastAPI error format)
    if (result.error) {
      throw new ProjectServiceError(result.error, "API_ERROR", response.status);
    }

    return result as T;
  } catch (error) {
    if (error instanceof ProjectServiceError) {
      throw error;
    }

    throw new ProjectServiceError(
      `Failed to call API ${endpoint}: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      500,
    );
  }
}

// Utility function for relative time formatting
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return "just now";
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} minutes ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hours ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)} days ago`;

  return `${Math.floor(diffInSeconds / 604800)} weeks ago`;
}
