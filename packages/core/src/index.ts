/**
 * @archon/core - Shared business logic for Archon
 *
 * This package contains:
 * - AI client adapters (Claude, Codex)
 * - Database operations (SQLite/PostgreSQL)
 * - Orchestration logic
 * - Workflow store adapter (bridges core DB to @archon/workflows IWorkflowStore)
 * - Utility functions
 */

// =============================================================================
// Types
// =============================================================================
export {
  ConversationNotFoundError,
  type Conversation,
  type HandleMessageContext,
  type AttachedFile,
  type Codebase,
  type Session,
  type CommandResult,
  type IPlatformAdapter,
  type IWebPlatformAdapter,
  isWebAdapter,
  type MessageMetadata,
} from './types';

// =============================================================================
// Database
// =============================================================================
export {
  pool,
  getDatabase,
  getDialect,
  getDatabaseType,
  closeDatabase,
  resetDatabase,
} from './db/connection';
export type { IDatabase, SqlDialect } from './db/adapters/types';

// Namespaced db modules for explicit access
export * as conversationDb from './db/conversations';
export * as codebaseDb from './db/codebases';
export * as sessionDb from './db/sessions';
export * as isolationEnvDb from './db/isolation-environments';
export * as workflowDb from './db/workflows';
export * as messageDb from './db/messages';

// Re-export SessionNotFoundError for error handling
export { SessionNotFoundError } from './db/sessions';

// =============================================================================
// Workflows
// =============================================================================

// Store adapter (bridges core DB to @archon/workflows IWorkflowStore)
export { createWorkflowStore } from './workflows/store-adapter';

// Workflow Events DB
export * as workflowEventDb from './db/workflow-events';

// =============================================================================
// Operations (shared business logic for CLI and command-handler)
// =============================================================================
export * as workflowOperations from './operations/workflow-operations';
export * as isolationOperations from './operations/isolation-operations';

// =============================================================================
// Orchestrator
// =============================================================================
export { handleMessage } from './orchestrator/orchestrator-agent';
export { buildOrchestratorPrompt, buildProjectScopedPrompt } from './orchestrator/prompt-builder';

// =============================================================================
// Handlers
// =============================================================================
export { handleCommand, parseCommand } from './handlers/command-handler';
export { cloneRepository, registerRepository, type RegisterResult } from './handlers/clone';

// =============================================================================
// Config
// =============================================================================
export {
  type GlobalConfig,
  type RepoConfig,
  type MergedConfig,
  type SafeConfig,
} from './config/config-types';

export {
  readConfigFile,
  loadGlobalConfig,
  loadRepoConfig,
  loadConfig,
  clearConfigCache,
  logConfig,
  toSafeConfig,
  updateGlobalConfig,
} from './config/config-loader';

// =============================================================================
// Services
// =============================================================================
export {
  startCleanupScheduler,
  stopCleanupScheduler,
  onConversationClosed,
  SESSION_RETENTION_DAYS,
} from './services/cleanup-service';

export { generateAndSetTitle } from './services/title-generator';

// =============================================================================
// State
// =============================================================================
export {
  type TransitionTrigger,
  shouldCreateNewSession,
  shouldDeactivateSession,
  detectPlanToExecuteTransition,
  getTriggerForCommand,
} from './state/session-transitions';

// =============================================================================
// Utils
// =============================================================================

// Conversation lock
export { ConversationLockManager, type LockAcquisitionResult } from './utils/conversation-lock';

// Error formatting
export { classifyAndFormatError } from './utils/error-formatter';
export { toError } from './utils/error';

// Credential sanitization
export { sanitizeCredentials, sanitizeError } from './utils/credential-sanitizer';

// GitHub GraphQL
export { getLinkedIssueNumbers } from './utils/github-graphql';

// Path validation
export { isPathWithinWorkspace, validateAndResolvePath } from './utils/path-validation';

// Port allocation
export { getPort } from './utils/port-allocation';

// Worktree sync
export { syncArchonToWorktree } from './utils/worktree-sync';
