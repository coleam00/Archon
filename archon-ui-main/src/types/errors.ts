/**
 * Structured error types for consistent error handling across the application.
 * Following existing patterns from projectService.ts and testService.ts.
 */

export interface ErrorContext {
  timestamp: string;
  correlationId?: string;
  url: string;
  method: string;
  status: number;
  statusText: string;
  serverContext?: Record<string, any>;
}

/**
 * Base database error class following the existing service error pattern
 */
export class DatabaseError extends Error {
  public readonly context: ErrorContext;
  public readonly code: string;
  public readonly remediation?: string;

  constructor(
    message: string,
    context: ErrorContext,
    code: string = 'DATABASE_ERROR',
    remediation?: string
  ) {
    super(message);
    this.name = 'DatabaseError';
    this.context = context;
    this.code = code;
    this.remediation = remediation;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      remediation: this.remediation,
      stack: this.stack,
    };
  }
}

/**
 * Database connection error for infrastructure failures
 */
export class DatabaseConnectionError extends DatabaseError {
  constructor(message: string, context: ErrorContext, remediation?: string) {
    super(message, context, 'DATABASE_CONNECTION_ERROR', remediation);
    this.name = 'DatabaseConnectionError';
  }
}

/**
 * Database configuration error for setup issues
 */
export class DatabaseConfigurationError extends DatabaseError {
  constructor(message: string, context: ErrorContext, remediation?: string) {
    super(message, context, 'DATABASE_CONFIGURATION_ERROR', remediation);
    this.name = 'DatabaseConfigurationError';
  }
}

/**
 * Network error for request failures
 */
export class NetworkError extends DatabaseError {
  constructor(message: string, context: ErrorContext, remediation?: string) {
    super(message, context, 'NETWORK_ERROR', remediation);
    this.name = 'NetworkError';
  }
}
