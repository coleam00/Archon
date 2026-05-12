/**
 * Database module exports
 *
 * Both namespace and direct imports are available:
 *   import { conversationDb, codebaseDb } from '@archon/core/db';  // Namespaced
 *   import { getOrCreateConversation } from '@archon/core/db';     // Direct
 *
 * Namespace imports provide clearer origin when using multiple modules
 * in the same file.
 */

// Connection management
export { pool, getDatabase, getDialect, closeDatabase, resetDatabase } from './connection';
export type { IDatabase, SqlDialect, QueryResult } from './adapters/types';

// Re-export namespaced for convenience
export * as conversationDb from './conversations';
export * as codebaseDb from './codebases';
export * as sessionDb from './sessions';
export * as isolationEnvDb from './isolation-environments';
export * as workflowDb from './workflows';

// Also export individual functions for direct imports
export * from './conversations';
export * from './codebases';
export { SessionNotFoundError } from './sessions';
export * from './sessions';
export * from './isolation-environments';
export * from './workflows';
