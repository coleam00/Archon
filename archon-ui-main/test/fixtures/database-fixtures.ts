/**
 * Test fixtures for database setup functionality
 *
 * Contains mock data for all database API responses, component states,
 * and service configurations needed for comprehensive testing.
 */

import {
  DatabaseStatus,
  SetupSQLResponse,
  VerifySetupResponse,
} from '../../src/services/databaseService';

export const mockDatabaseStatuses = {
  ready: {
    initialized: true,
    setup_required: false,
    message: 'Database is properly initialized',
  } as DatabaseStatus,

  needsSetup: {
    initialized: false,
    setup_required: true,
    message: 'Database tables are missing and need to be created',
  } as DatabaseStatus,

  connectionError: {
    initialized: false,
    setup_required: false,
    message:
      'Database connectivity check failed during credential loading: Connection refused',
  } as DatabaseStatus,

  credentialError: {
    initialized: false,
    setup_required: false,
    message:
      'Database connectivity check failed during credential loading: Invalid credentials',
  } as DatabaseStatus,

  timeout: {
    initialized: false,
    setup_required: false,
    message:
      'Database connectivity check failed during credential loading: Request timeout',
  } as DatabaseStatus,
};

export const mockSetupSQLResponses = {
  complete: {
    sql_content: `-- =====================================================
-- Archon Complete Database Setup
-- =====================================================
-- This script combines all migrations into a single file
-- for easy one-time database initialization

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create the main settings table
CREATE TABLE IF NOT EXISTS archon_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,
    encrypted_value TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    category VARCHAR(100),
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_archon_settings_key ON archon_settings(key);
CREATE INDEX IF NOT EXISTS idx_archon_settings_category ON archon_settings(category);`,
    project_id: 'abc123def456',
    sql_editor_url:
      'https://supabase.com/dashboard/project/abc123def456/sql/new',
  } as SetupSQLResponse,

  minimal: {
    sql_content: '-- Minimal SQL setup\nCREATE EXTENSION IF NOT EXISTS vector;',
    project_id: null,
    sql_editor_url: null,
  } as SetupSQLResponse,

  longSQL: {
    sql_content: Array(50)
      .fill(
        '-- This is a very long SQL statement that tests clipboard functionality'
      )
      .join('\n'),
    project_id: 'longproject123',
    sql_editor_url:
      'https://supabase.com/dashboard/project/longproject123/sql/new',
  } as SetupSQLResponse,

  specialCharacters: {
    sql_content: `-- SQL with special characters: !@#$%^&*()
CREATE TABLE "test-table" (
    "column-name" TEXT,
    'single_quotes' VARCHAR(255),
    "unicode_∀∃∈∉" JSONB DEFAULT '{}'::jsonb
);`,
    project_id: 'special-chars-123',
    sql_editor_url:
      'https://supabase.com/dashboard/project/special-chars-123/sql/new',
  } as SetupSQLResponse,

  emptySQL: {
    sql_content: '',
    project_id: 'empty123',
    sql_editor_url: 'https://supabase.com/dashboard/project/empty123/sql/new',
  } as SetupSQLResponse,
};

export const mockVerificationResponses = {
  success: {
    success: true,
    message: 'Database setup verified successfully',
  } as VerifySetupResponse,

  failure: {
    success: false,
    message: 'Database tables still not found - please run the setup SQL',
  } as VerifySetupResponse,

  networkError: {
    success: false,
    message: 'Database verification failed: Network request failed',
  } as VerifySetupResponse,

  timeoutError: {
    success: false,
    message: 'Database verification failed: Request timeout after 30 seconds',
  } as VerifySetupResponse,

  permissionError: {
    success: false,
    message:
      'Database verification failed: Insufficient permissions to access database',
  } as VerifySetupResponse,

  malformedError: {
    success: false,
    message: 'Database verification failed: Malformed response from server',
  } as VerifySetupResponse,
};

export const mockErrorResponses = {
  networkError: new Error('Failed to fetch'),

  httpError404: new Error('Failed to get database status: Not Found'),

  httpError500: new Error(
    'Failed to get database status: Internal Server Error'
  ),

  httpError503: new Error('Failed to get database status: Service Unavailable'),

  corsError: new Error('Failed to get database status: CORS policy violation'),

  timeoutError: new Error('Failed to get database status: Request timeout'),

  jsonParseError: new Error('Failed to parse JSON response'),

  unexpectedError: new Error(
    'An unexpected error occurred during database operation'
  ),
};

export const mockComponentStates = {
  initial: {
    status: null,
    setupData: null,
    loading: true,
    autoVerifying: false,
    copied: false,
    error: null,
    step1Completed: false,
    step1Animating: false,
    step2Completed: false,
    step2Animating: false,
  },

  loadingState: {
    status: null,
    setupData: null,
    loading: true,
    autoVerifying: false,
    copied: false,
    error: null,
    step1Completed: false,
    step1Animating: false,
    step2Completed: false,
    step2Animating: false,
  },

  readyState: {
    status: mockDatabaseStatuses.ready,
    setupData: null,
    loading: false,
    autoVerifying: false,
    copied: false,
    error: null,
    step1Completed: false,
    step1Animating: false,
    step2Completed: false,
    step2Animating: false,
  },

  setupRequiredState: {
    status: mockDatabaseStatuses.needsSetup,
    setupData: mockSetupSQLResponses.complete,
    loading: false,
    autoVerifying: true,
    copied: false,
    error: null,
    step1Completed: false,
    step1Animating: false,
    step2Completed: false,
    step2Animating: false,
  },

  step1CompletedState: {
    status: mockDatabaseStatuses.needsSetup,
    setupData: mockSetupSQLResponses.complete,
    loading: false,
    autoVerifying: true,
    copied: true,
    error: null,
    step1Completed: true,
    step1Animating: true,
    step2Completed: false,
    step2Animating: false,
  },

  bothStepsCompletedState: {
    status: mockDatabaseStatuses.needsSetup,
    setupData: mockSetupSQLResponses.complete,
    loading: false,
    autoVerifying: true,
    copied: false,
    error: null,
    step1Completed: true,
    step1Animating: false,
    step2Completed: true,
    step2Animating: true,
  },

  errorState: {
    status: null,
    setupData: null,
    loading: false,
    autoVerifying: false,
    copied: false,
    error: 'Failed to check database status: Network request failed',
    step1Completed: false,
    step1Animating: false,
    step2Completed: false,
    step2Animating: false,
  },

  verificationErrorState: {
    status: mockDatabaseStatuses.needsSetup,
    setupData: mockSetupSQLResponses.complete,
    loading: false,
    autoVerifying: false,
    copied: false,
    error: 'Database tables still not found - please run the setup SQL',
    step1Completed: true,
    step1Animating: false,
    step2Completed: true,
    step2Animating: false,
  },
};

export const mockAnimationStates = {
  noAnimation: {
    step1Completed: false,
    step1Animating: false,
    step2Completed: false,
    step2Animating: false,
  },

  step1Animating: {
    step1Completed: true,
    step1Animating: true,
    step2Completed: false,
    step2Animating: false,
  },

  step2Animating: {
    step1Completed: true,
    step1Animating: false,
    step2Completed: true,
    step2Animating: true,
  },

  bothCompleted: {
    step1Completed: true,
    step1Animating: false,
    step2Completed: true,
    step2Animating: false,
  },

  rapidTransition: {
    step1Completed: true,
    step1Animating: true,
    step2Completed: true,
    step2Animating: true,
  },
};

export const mockPollingScenarios = {
  immediate: {
    interval: 3000,
    maxAttempts: 1,
    responses: [mockVerificationResponses.success],
  },

  delayed: {
    interval: 3000,
    maxAttempts: 3,
    responses: [
      mockVerificationResponses.failure,
      mockVerificationResponses.failure,
      mockVerificationResponses.success,
    ],
  },

  failure: {
    interval: 3000,
    maxAttempts: 5,
    responses: Array(5).fill(mockVerificationResponses.failure),
  },
};

export const mockEnvironmentConfigs = {
  development: {
    VITE_API_URL: 'http://localhost:8181',
    NODE_ENV: 'development',
  },

  testing: {
    VITE_API_URL: 'http://test-api:8181',
    NODE_ENV: 'test',
  },
};

export const mockNetworkScenarios = {
  normal: {
    status: 200,
    ok: true,
    delay: 100,
  },

  serverError: {
    status: 500,
    ok: false,
    delay: 100,
  },

  networkError: {
    status: 0,
    ok: false,
    delay: 0,
    error: new Error('Network request failed'),
  },

  timeout: {
    status: 0,
    ok: false,
    delay: 30000,
  },
};

export const mockEdgeCases = {
  emptyResponse: {},

  nullValues: {
    status: null,
    setupData: null,
    error: null,
  },

  undefinedValues: {
    status: undefined,
    setupData: undefined,
    error: undefined,
  },

  malformedStatus: {
    initialized: 'not-boolean',
    setup_required: 'also-not-boolean',
    message: 123,
  },

  malformedSetupSQL: {
    sql_content: null,
    project_id: 123,
    sql_editor_url: false,
  },
};

/**
 * Creates a custom database status response
 */
export function createDatabaseStatus(
  overrides: Partial<DatabaseStatus> = {}
): DatabaseStatus {
  return {
    ...mockDatabaseStatuses.needsSetup,
    ...overrides,
  };
}

/**
 * Creates a custom setup SQL response
 */
export function createSetupSQLResponse(
  overrides: Partial<SetupSQLResponse> = {}
): SetupSQLResponse {
  return {
    ...mockSetupSQLResponses.complete,
    ...overrides,
  };
}

/**
 * Creates a custom verification response
 */
export function createVerificationResponse(
  overrides: Partial<VerifySetupResponse> = {}
): VerifySetupResponse {
  return {
    ...mockVerificationResponses.success,
    ...overrides,
  };
}

/**
 * Creates a mock fetch response
 */
export function createMockFetchResponse(
  data: any,
  options: Partial<Response> = {}
): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    ...options,
  } as Response;
}

/**
 * Creates a series of polling responses for testing auto-verification
 */
export function createPollingResponseSequence(
  scenario: keyof typeof mockPollingScenarios
) {
  const config = mockPollingScenarios[scenario];
  return config.responses.map((response, index) => ({
    response,
    callCount: index + 1,
    delay: config.interval,
  }));
}

/**
 * Creates test data for component state transitions
 */
export function createStateTransition(
  from: keyof typeof mockComponentStates,
  to: keyof typeof mockComponentStates
) {
  return {
    initialState: mockComponentStates[from],
    finalState: mockComponentStates[to],
    transition: `${from} -> ${to}`,
  };
}
