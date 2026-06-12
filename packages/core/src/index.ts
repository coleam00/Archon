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
  type User,
  type UserIdentity,
  type UserRole,
  type IdentityPlatform,
} from './types';

// =============================================================================
// Database
// =============================================================================
export {
  pool,
  getDatabase,
  getDialect,
  getDatabaseType,
  getDbNotificationListener,
  closeDatabase,
  resetDatabase,
} from './db/connection';
export type { IDatabase, SqlDialect, DbNotificationListener } from './db/adapters/types';

// Namespaced db modules for explicit access
export * as conversationDb from './db/conversations';
export * as codebaseDb from './db/codebases';
export * as sessionDb from './db/sessions';
export * as isolationEnvDb from './db/isolation-environments';
export * as workflowDb from './db/workflows';
export * as messageDb from './db/messages';
export * as userDb from './db/users';

// Re-export SessionNotFoundError for error handling
export { SessionNotFoundError } from './db/sessions';

// =============================================================================
// Workflows
// =============================================================================

// Store adapter (bridges core DB to @archon/workflows IWorkflowStore)
export {
  createWorkflowStore,
  createWorkflowDeps,
  registerGitHubAppAuthProvider,
} from './workflows/store-adapter';

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
export {
  buildOrchestratorPrompt,
  buildProjectScopedPrompt,
  buildOrchestratorSystemAppend,
} from './orchestrator/prompt-builder';

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
  type TiersPatch,
  type AliasesPatch,
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

// GitHub App auth
export {
  createGitHubAppAuthProvider,
  loadAppPrivateKey,
  installCredentialHelper,
  AppNotInstalledError,
  AppPrivateKeyError,
  type GitHubAppConfig,
  type IGitHubAppAuthProvider,
  type GitHubAuth,
  // Per-user device flow (PR-C)
  isPerUserGitHubEnabled,
  loadDeviceFlowConfig,
  assertEncryptionKeyAtBoot,
  connectGithubForUser,
  persistGithubConnection,
  startDeviceFlow,
  pollDeviceFlowOnce,
  DeviceFlowError,
  type DeviceCodeResponse,
  type DeviceAccessToken,
  type PollOnceResult,
  type ConnectGithubResult,
} from './github-auth';

// Per-user GitHub token store (PR-C)
export {
  saveUserGithubToken,
  getUserGithubTokenRecord,
  getDecryptedAccessToken,
  deleteUserGithubToken,
  getUserGithubNoreplyEmail,
} from './db/user-github-token-store';
export {
  updateUserGithubProfile,
  linkGithubIdentity,
  GithubIdentityConflictError,
} from './db/users';

// Per-user AI-provider credentials (Phase 2, #1891 PR-1)
// Public foundation: gate + delivery map. PR-2 will add connect-service /
// route handlers; PR-3 will add the OAuth bridge.
export {
  isPerUserProviderKeysEnabled,
  assertProviderKeysKeyAtBoot,
  deliverCredential,
  KNOWN_VENDORS,
  LEGACY_VENDOR_ALIASES,
  normalizeCredentialVendor,
  getVendorCatalog,
  listConnectableVendors,
  isConnectableVendor,
  buildAgentCredentialMatrix,
  persistProviderApiKey,
  persistProviderOAuth,
  InvalidProviderKeyError,
  SUBSCRIPTION_PROVIDERS,
  startOAuth,
  pollOAuth,
  cancelOAuth,
  OAuthCallbackPortBusyError,
  type ResolvedCredential,
  type DeliveryResult,
  type DeliveryOptions,
  type OAuthCredentials,
  type VendorCatalogEntry,
  type AgentCredentialStatus,
  type AgentCredentialMatrixEntry,
  type PersistProviderApiKeyResult,
  type PersistProviderOAuthResult,
  type StartOAuthResult,
  type PollOAuthResult,
} from './credentials';
export {
  saveUserProviderKey,
  getUserProviderKeyRecord,
  listUserProviderKeys,
  deleteUserProviderKey,
  getDecryptedProviderCredential,
  listDecryptedUserProviderCredentials,
  type SaveUserProviderKeyParams,
} from './db/user-provider-key-store';
export {
  getUserAiPrefs,
  setUserTiers,
  setUserAliases,
  setUserDefaultProvider,
  clearUserAiPrefs,
  type UserAiPrefs,
  type UserTiersPatch,
  type UserAliasesPatch,
} from './db/user-ai-prefs-store';

// Path validation
export { isPathWithinWorkspace, validateAndResolvePath } from './utils/path-validation';

// Port allocation
export { getPort } from './utils/port-allocation';

// Worktree sync
export { syncArchonToWorktree } from './utils/worktree-sync';
