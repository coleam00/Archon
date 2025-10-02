/**
 * Provider-agnostic error handler for LLM operations
 * Supports OpenAI, Google AI, Anthropic, and other providers
 */

export interface ProviderError extends Error {
  statusCode?: number;
  provider?: string;
  errorType?: string;
  isProviderError?: boolean;
}

// Type guards for error object properties
interface ErrorWithStatus {
  statusCode?: number;
  status?: number;
}

interface ErrorWithMessage {
  message?: string;
}

// Type guard functions
function hasStatusProperty(obj: unknown): obj is ErrorWithStatus {
  return typeof obj === "object" && obj !== null && ("statusCode" in obj || "status" in obj);
}

function hasMessageProperty(obj: unknown): obj is ErrorWithMessage {
  return typeof obj === "object" && obj !== null && "message" in obj;
}

/**
 * Parse backend error responses into provider-aware error objects
 */
export function parseProviderError(error: unknown): ProviderError {
  // Handle null, undefined, and non-object types
  if (!error || typeof error !== "object") {
    const result: ProviderError = {
      name: "Error",
    } as ProviderError;

    // Only set message for non-null/undefined values
    if (error) {
      result.message = String(error);
    }

    return result;
  }

  const providerError = error as ProviderError;

  // Type-safe status code extraction
  if (hasStatusProperty(error)) {
    providerError.statusCode = error.statusCode || error.status;
  }

  // Parse backend error structure with type safety
  if (hasMessageProperty(error) && error.message && error.message.includes("detail")) {
    try {
      const parsed = JSON.parse(error.message);
      if (parsed.detail?.error_type) {
        providerError.isProviderError = true;
        providerError.provider = parsed.detail.provider || "LLM";
        providerError.errorType = parsed.detail.error_type;
        providerError.message = parsed.detail.message || error.message;
      }
    } catch {
      // If parsing fails, use message as-is
    }
  }

  return providerError;
}

/**
 * Get user-friendly error message for any LLM provider
 */
export function getProviderErrorMessage(error: unknown): string {
  const parsed = parseProviderError(error);

  if (parsed.isProviderError) {
    const provider = parsed.provider || "LLM";

    switch (parsed.errorType) {
      case "authentication_failed":
        return `Please verify your ${provider} API key in Settings.`;
      case "quota_exhausted":
        return `${provider} quota exhausted. Please check your billing settings.`;
      case "rate_limit":
        return `${provider} rate limit exceeded. Please wait and try again.`;
      default:
        return `${provider} API error. Please check your configuration.`;
    }
  }

  // Handle status codes for non-structured errors
  if (parsed.statusCode === 401) {
    return "Please verify your API key in Settings.";
  }

  return parsed.message || "An error occurred.";
}
