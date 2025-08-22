/**
 * Error handling utilities for knowledge base operations
 * 
 * Provides specialized error handling for OpenAI API errors,
 * rate limiting, and quota exhaustion scenarios.
 * 
 * Related to GitHub issue #362 - improves user experience
 * by displaying clear error messages when OpenAI API fails.
 */

export interface OpenAIErrorDetails {
  error: string;
  message: string;
  error_type: 'quota_exhausted' | 'rate_limit' | 'api_error';
  tokens_used?: number;
  retry_after?: number;
}

export interface EnhancedError extends Error {
  statusCode?: number;
  errorDetails?: OpenAIErrorDetails;
  isOpenAIError?: boolean;
}

/**
 * Create a fallback error for cases where input is invalid or unparseable
 */
function createFallbackError(reason: string): EnhancedError {
  return Object.assign(new Error('Unknown error occurred'), {
    errorDetails: {
      error: 'unknown',
      message: `${reason}. Please try again or contact support if the problem persists.`,
      error_type: 'api_error' as const
    }
  }) as EnhancedError;
}

/**
 * Check if an object can be safely serialized (no circular references)
 */
function isSafeObject(obj: any): boolean {
  if (typeof obj !== 'object' || obj === null) return true;
  
  // Quick size estimate to prevent expensive operations on large objects
  const keys = Object.keys(obj);
  if (keys.length > 100) return false;
  
  // Check for deep nesting that could indicate circular references
  let depth = 0;
  function checkDepth(value: any, currentDepth: number): boolean {
    if (currentDepth > 10) return false; // Max depth exceeded
    if (typeof value !== 'object' || value === null) return true;
    
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        if (!checkDepth(value[key], currentDepth + 1)) return false;
      }
    }
    return true;
  }
  
  if (!checkDepth(obj, 0)) return false;
  
  try {
    JSON.stringify(obj);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse and enhance API errors from knowledge base operations
 */
export function parseKnowledgeBaseError(error: any): EnhancedError {
  // Enhanced input validation
  if (!error) {
    return createFallbackError('No error information provided');
  }
  
  if (typeof error === 'string') {
    return Object.assign(new Error(error), {
      errorDetails: {
        error: 'api_error',
        message: error,
        error_type: 'api_error' as const
      }
    }) as EnhancedError;
  }
  
  if (typeof error !== 'object' || error === null) {
    return createFallbackError('Invalid error format');
  }

  // Check for empty objects or objects with no useful properties
  if (error.constructor === Object && Object.keys(error).length === 0) {
    return createFallbackError('Empty error object received');
  }

  // Check for circular references and object safety
  if (!isSafeObject(error)) {
    return createFallbackError('Error object contains circular references');
  }

  // Handle Error instances that might have been serialized/deserialized
  if (error instanceof Error || (error.name && error.message && error.stack)) {
    // This is likely an Error object, proceed with parsing
  } else if (!error.message && !error.error && !error.detail && !error.status) {
    // Object doesn't have any recognizable error properties
    return createFallbackError('Unrecognized error object structure');
  }
  
  const enhancedError: EnhancedError = new Error(error.message || 'Unknown error');
  
  // Check if this is an HTTP response error with JSON details
  if (error && typeof error === 'object') {
    // Handle fetch Response errors
    if (error.status) {
      enhancedError.statusCode = error.status;
    }
    
    // Parse error details from API response
    if (error.error || error.detail) {
      const errorData = error.error || error.detail;
      
      // Check if it's an OpenAI-specific error
      if (typeof errorData === 'object' && errorData.error_type) {
        enhancedError.isOpenAIError = true;
        enhancedError.errorDetails = errorData as OpenAIErrorDetails;
        
        // Override the message with the detailed error message
        enhancedError.message = errorData.message || errorData.error || enhancedError.message;
      }
    }
  }
  
  return enhancedError;
}

/**
 * Get user-friendly error message for display in UI
 */
export function getDisplayErrorMessage(error: EnhancedError): string {
  if (error.isOpenAIError && error.errorDetails) {
    switch (error.errorDetails.error_type) {
      case 'quota_exhausted':
        return `OpenAI API quota exhausted. Please add credits to your OpenAI account or check your billing settings.`;
      
      case 'rate_limit':
        return `OpenAI API rate limit exceeded. Please wait a moment and try again.`;
      
      case 'api_error':
        return `OpenAI API error: ${error.errorDetails.message}. Please check your API key configuration.`;
      
      default:
        return error.errorDetails.message || error.message;
    }
  }
  
  // Handle HTTP status codes
  if (error.statusCode) {
    switch (error.statusCode) {
      case 429:
        return 'API rate limit exceeded. Please wait a moment and try again.';
      case 502:
        return 'API service unavailable. Please try again in a few minutes.';
      case 503:
        return 'Service temporarily unavailable. Please try again later.';
      default:
        return error.message;
    }
  }
  
  return error.message || 'An unexpected error occurred.';
}

/**
 * Get error severity level for UI styling
 */
export function getErrorSeverity(error: EnhancedError): 'error' | 'warning' | 'info' {
  if (error.isOpenAIError && error.errorDetails) {
    switch (error.errorDetails.error_type) {
      case 'quota_exhausted':
        return 'error'; // Critical - user action required
      case 'rate_limit':
        return 'warning'; // Temporary - retry may work
      case 'api_error':
        return 'error'; // Likely configuration issue
      default:
        return 'error';
    }
  }
  
  if (error.statusCode && error.statusCode >= 500) {
    return 'error'; // Server errors
  }
  
  return 'warning'; // Default to warning for other errors
}

/**
 * Get suggested action for the user based on error type
 */
export function getErrorAction(error: EnhancedError): string | null {
  if (error.isOpenAIError && error.errorDetails) {
    switch (error.errorDetails.error_type) {
      case 'quota_exhausted':
        return 'Check your OpenAI billing dashboard and add credits';
      case 'rate_limit':
        const retryAfter = error.errorDetails.retry_after || 30;
        return `Wait ${retryAfter} seconds and try again`;
      case 'api_error':
        return 'Verify your OpenAI API key in Settings';
      default:
        return null;
    }
  }
  
  return null;
}