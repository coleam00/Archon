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
  error_type: 'authentication_required' | 'authentication_failed' | 'quota_exhausted' | 'rate_limit' | 'api_error';
  tokens_used?: number;
  retry_after?: number;
}

// Valid OpenAI error types
const VALID_ERROR_TYPES = [
  'authentication_required',
  'authentication_failed', 
  'quota_exhausted', 
  'rate_limit', 
  'api_error'
] as const;

/**
 * Validate and normalize error type from API response
 */
function validateErrorType(errorType: any): OpenAIErrorDetails['error_type'] {
  if (typeof errorType === 'string' && VALID_ERROR_TYPES.includes(errorType as any)) {
    return errorType as OpenAIErrorDetails['error_type'];
  }
  return 'api_error'; // Default fallback
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

// Constants for validation
const MAX_OBJECT_KEYS = 100;
const MAX_RECURSION_DEPTH = 10;

/**
 * Check if an object can be safely serialized (no circular references)
 */
function isSafeObject(obj: any): boolean {
  if (typeof obj !== 'object' || obj === null) return true;
  
  // Quick size check to prevent expensive operations on large objects
  if (Object.keys(obj).length > MAX_OBJECT_KEYS) return false;
  
  // Use WeakSet for cycle detection - more efficient than recursive depth checking
  const visited = new WeakSet();
  
  function hasCycles(value: any, depth = 0): boolean {
    if (depth > MAX_RECURSION_DEPTH) return true; // Prevent deep recursion
    if (typeof value !== 'object' || value === null) return false;
    
    if (visited.has(value)) return true; // Circular reference detected
    visited.add(value);
    
    try {
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key) && hasCycles(value[key], depth + 1)) {
          return true;
        }
      }
    } catch {
      return true; // Error during traversal indicates unsafe object
    }
    
    return false;
  }
  
  return !hasCycles(obj);
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
        
        // Validate and normalize the error details
        const validatedErrorType = validateErrorType(errorData.error_type);
        enhancedError.errorDetails = {
          error: errorData.error || 'unknown',
          message: errorData.message || 'Unknown error occurred',
          error_type: validatedErrorType,
          tokens_used: typeof errorData.tokens_used === 'number' ? errorData.tokens_used : undefined,
          retry_after: typeof errorData.retry_after === 'number' ? errorData.retry_after : undefined
        };
        
        // Set a more descriptive message based on error type
        switch (validatedErrorType) {
          case 'authentication_required':
          case 'authentication_failed':
            enhancedError.message = '401 Unauthorized - Invalid OpenAI API key. Please verify your OpenAI API key in Settings before starting a crawl.';
            break;
          case 'quota_exhausted':
            enhancedError.message = 'OpenAI API quota exhausted. Please add credits to your OpenAI account or check your billing settings.';
            break;
          case 'rate_limit':
            enhancedError.message = 'OpenAI API rate limit exceeded. Please wait a moment and try again.';
            break;
          case 'api_error':
            enhancedError.message = `OpenAI API error: ${errorData.message}. Please check your API key configuration.`;
            break;
          default:
            enhancedError.message = errorData.message || errorData.error || enhancedError.message;
        }
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
      case 'authentication_required':
      case 'authentication_failed':
        return `401 Unauthorized - Invalid OpenAI API key. Please verify your OpenAI API key in Settings before starting a crawl.`;
      
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
      case 401:
        return '401 Unauthorized - Invalid or missing OpenAI credentials. Verify your API key in Settings.';
      case 403:
        return '403 Forbidden - Your OpenAI key/org/project lacks access to this operation.';
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
  if (error.statusCode === 401 || error.statusCode === 403) return 'error';
  if (error.statusCode === 429) return 'warning';
  return 'warning'; // Default for other 4xx/unknown
}

/**
 * Get suggested action for the user based on error type
 */
export function getErrorAction(error: EnhancedError): string | null {
  if (error.isOpenAIError && error.errorDetails) {
    switch (error.errorDetails.error_type) {
      case 'authentication_required':
      case 'authentication_failed':
        return 'Go to Settings and verify your OpenAI API key';
      case 'quota_exhausted':
        return 'Check your OpenAI billing dashboard and add credits';
      case 'rate_limit': {
        const retryAfter = error.errorDetails.retry_after ?? 30;
        return `Wait ${retryAfter} seconds and try again`;
      }
      case 'api_error':
        return 'Verify your OpenAI API key in Settings';
      default:
        return null;
    }
  }
  
  // HTTP fallback when no OpenAI-specific details are present
  if (error.statusCode) {
    switch (error.statusCode) {
      case 401:
        return 'Go to Settings and verify your OpenAI API key';
      case 403:
        return 'Check your OpenAI org/project permissions';
      case 429: {
        const retryAfter = error.errorDetails?.retry_after ?? 30;
        return `Wait ${retryAfter} seconds and try again`;
      }
      default:
        return null;
    }
  }
  return null;
}