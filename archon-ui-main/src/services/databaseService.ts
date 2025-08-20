/**
 * Database service for managing database setup and status
 *
 * Implements tiered error handling:
 * - Infrastructure errors (500s) -> DatabaseConnectionError
 * - Configuration errors (400s) -> DatabaseConfigurationError
 * - Network errors -> NetworkError
 */

import {
  DatabaseError,
  DatabaseConnectionError,
  DatabaseConfigurationError,
  NetworkError,
  type ErrorContext,
} from '../types/errors';
import { createLogger } from '../utils/logger';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8181';

/**
 * Database initialization status information
 */
export interface DatabaseStatus {
  /** Whether the database is properly initialized */
  initialized: boolean;
  /** Whether database setup is required */
  setup_required: boolean;
  /** Human-readable status message */
  message: string;
}

/**
 * Response containing SQL setup content and related URLs
 */
export interface SetupSQLResponse {
  /** SQL content for database setup */
  sql_content: string;
  /** Extracted project ID from Supabase URL, if available */
  project_id: string | null;
  /** Direct link to Supabase SQL editor, if available */
  sql_editor_url: string | null;
}

/**
 * Response from database setup verification
 */
export interface VerifySetupResponse {
  /** Whether verification was successful */
  success: boolean;
  /** Human-readable verification result message */
  message: string;
}

/**
 * Service for managing database setup and status operations
 *
 * Provides methods to check database status, retrieve setup SQL,
 * and verify database initialization. Uses singleton pattern.
 */
export class DatabaseService {
  private static instance: DatabaseService;
  private logger = createLogger('DatabaseService');

  /**
   * Get the singleton instance of DatabaseService
   * @returns The singleton DatabaseService instance
   */
  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  /**
   * Check the current database status with detailed error context preservation
   * @returns Promise resolving to database status information
   * @throws DatabaseError variants based on error type
   */
  async getStatus(): Promise<DatabaseStatus> {
    const correlationId = crypto.randomUUID();
    const startTime = Date.now();

    this.logger
      .withCorrelationId(correlationId)
      .debug('Checking database status');

    try {
      const response = await fetch(`${API_BASE_URL}/api/database/status`, {
        headers: {
          'X-Correlation-ID': correlationId,
        },
      });

      const context: ErrorContext = {
        timestamp: new Date().toISOString(),
        correlationId,
        url: response.url,
        method: 'GET',
        status: response.status,
        statusText: response.statusText,
      };

      if (!response.ok) {
        let errorDetails;
        try {
          errorDetails = await response.json();
        } catch {
          errorDetails = { detail: response.statusText };
        }

        const serverError =
          errorDetails.detail || errorDetails.error || response.statusText;
        const serverContext = errorDetails.context || {};
        const remediation = errorDetails.remediation;

        this.logger
          .withCorrelationId(correlationId)
          .error('Status check failed', {
            status: response.status,
            serverError,
            serverContext,
            duration: Date.now() - startTime,
          });

        context.serverContext = serverContext;

        if (response.status >= 500) {
          throw new DatabaseConnectionError(
            `Database connection failed: ${serverError}`,
            context,
            remediation
          );
        } else if (response.status >= 400) {
          throw new DatabaseConfigurationError(
            `Database configuration error: ${serverError}`,
            context,
            remediation
          );
        } else {
          throw new DatabaseError(
            `Database status check failed: ${serverError}`,
            context,
            'DATABASE_STATUS_ERROR',
            remediation
          );
        }
      }

      const status = await response.json();
      const duration = Date.now() - startTime;

      this.logger
        .withCorrelationId(correlationId)
        .debug('Status check completed', {
          duration,
          initialized: status.initialized,
          setupRequired: status.setup_required,
        });

      return status;
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }

      const context: ErrorContext = {
        timestamp: new Date().toISOString(),
        correlationId,
        url: `${API_BASE_URL}/api/database/status`,
        method: 'GET',
        status: 0,
        statusText: 'Network Error',
      };

      this.logger
        .withCorrelationId(correlationId)
        .error('Network error during status check', {
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        });

      throw new NetworkError(
        `Network error during database status check: ${
          error instanceof Error ? error.message : String(error)
        }`,
        context,
        'Check network connectivity and server status'
      );
    }
  }

  /**
   * Get the setup SQL content and related URLs with error context preservation
   * @returns Promise resolving to setup SQL content and URLs
   * @throws DatabaseError variants based on error type
   */
  async getSetupSQL(): Promise<SetupSQLResponse> {
    const correlationId = crypto.randomUUID();
    const startTime = Date.now();

    this.logger
      .withCorrelationId(correlationId)
      .debug('Fetching setup SQL content');

    try {
      const response = await fetch(`${API_BASE_URL}/api/database/setup-sql`, {
        headers: {
          'X-Correlation-ID': correlationId,
        },
      });

      const context: ErrorContext = {
        timestamp: new Date().toISOString(),
        correlationId,
        url: response.url,
        method: 'GET',
        status: response.status,
        statusText: response.statusText,
      };

      if (!response.ok) {
        let errorDetails;
        try {
          errorDetails = await response.json();
        } catch {
          errorDetails = { detail: response.statusText };
        }

        const serverError =
          errorDetails.detail || errorDetails.error || response.statusText;
        const serverContext = errorDetails.context || {};
        const remediation = errorDetails.remediation;

        this.logger
          .withCorrelationId(correlationId)
          .error('Setup SQL fetch failed', {
            status: response.status,
            serverError,
            serverContext,
            duration: Date.now() - startTime,
          });

        context.serverContext = serverContext;

        if (response.status >= 500) {
          throw new DatabaseConnectionError(
            `Failed to get setup SQL: ${serverError}`,
            context,
            remediation
          );
        } else {
          throw new DatabaseConfigurationError(
            `Setup SQL configuration error: ${serverError}`,
            context,
            remediation
          );
        }
      }

      const setupData = await response.json();
      const duration = Date.now() - startTime;

      this.logger
        .withCorrelationId(correlationId)
        .debug('Setup SQL fetched successfully', {
          duration,
          contentLength: setupData.sql_content?.length || 0,
          hasProjectId: !!setupData.project_id,
          hasEditorUrl: !!setupData.sql_editor_url,
        });

      return setupData;
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }

      const context: ErrorContext = {
        timestamp: new Date().toISOString(),
        correlationId,
        url: `${API_BASE_URL}/api/database/setup-sql`,
        method: 'GET',
        status: 0,
        statusText: 'Network Error',
      };

      this.logger
        .withCorrelationId(correlationId)
        .error('Network error during setup SQL fetch', {
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        });

      throw new NetworkError(
        `Network error during setup SQL fetch: ${
          error instanceof Error ? error.message : String(error)
        }`,
        context,
        'Check network connectivity and server status'
      );
    }
  }

  /**
   * Verify that the database has been properly set up with error context preservation
   * @returns Promise resolving to verification result
   * @throws DatabaseError variants based on error type
   */
  async verifySetup(): Promise<VerifySetupResponse> {
    const correlationId = crypto.randomUUID();
    const startTime = Date.now();

    this.logger
      .withCorrelationId(correlationId)
      .debug('Verifying database setup');

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/database/verify-setup`,
        {
          method: 'POST',
          headers: {
            'X-Correlation-ID': correlationId,
          },
        }
      );

      const context: ErrorContext = {
        timestamp: new Date().toISOString(),
        correlationId,
        url: response.url,
        method: 'POST',
        status: response.status,
        statusText: response.statusText,
      };

      if (!response.ok) {
        let errorDetails;
        try {
          errorDetails = await response.json();
        } catch {
          errorDetails = { detail: response.statusText };
        }

        const serverError =
          errorDetails.detail || errorDetails.error || response.statusText;
        const serverContext = errorDetails.context || {};
        const remediation = errorDetails.remediation;

        this.logger
          .withCorrelationId(correlationId)
          .error('Setup verification failed', {
            status: response.status,
            serverError,
            serverContext,
            duration: Date.now() - startTime,
          });

        context.serverContext = serverContext;

        if (response.status >= 500) {
          throw new DatabaseConnectionError(
            `Setup verification failed: ${serverError}`,
            context,
            remediation
          );
        } else {
          throw new DatabaseConfigurationError(
            `Setup verification error: ${serverError}`,
            context,
            remediation
          );
        }
      }

      const result = await response.json();
      const duration = Date.now() - startTime;

      this.logger
        .withCorrelationId(correlationId)
        .debug('Setup verification completed', {
          duration,
          success: result.success,
          message: result.message,
        });

      return result;
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }

      const context: ErrorContext = {
        timestamp: new Date().toISOString(),
        correlationId,
        url: `${API_BASE_URL}/api/database/verify-setup`,
        method: 'POST',
        status: 0,
        statusText: 'Network Error',
      };

      this.logger
        .withCorrelationId(correlationId)
        .error('Network error during setup verification', {
          error: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
        });

      throw new NetworkError(
        `Network error during setup verification: ${
          error instanceof Error ? error.message : String(error)
        }`,
        context,
        'Check network connectivity and server status'
      );
    }
  }
}

/**
 * Singleton instance of DatabaseService for application-wide use
 */
export const databaseService = DatabaseService.getInstance();
