/**
 * Core Zod schemas and derived types.
 *
 * All data-shape types are derived from schemas via `z.infer<typeof schema>`.
 * Schemas may import plain `zod`; OpenAPI annotations use `@hono/zod-openapi`.
 */

// Conversation
export { conversationRowSchema, identityPlatformSchema } from './conversation';
export type { Conversation, IdentityPlatform } from './conversation';

// Message
export { messageRowSchema } from './message';
export type { MessageRow } from './message';

// User
export { userRowSchema, userIdentityRowSchema, userRoleSchema } from './user';
export type { User, UserIdentity, UserRole } from './user';
export { userGithubTokenRowSchema } from './user-github-token-row';
export type { UserGithubTokenRow } from './user-github-token-row';
export { userAiPrefsRowSchema } from './user-ai-prefs-row';
export type { UserAiPrefsRow } from './user-ai-prefs-row';

// Codebase
export { codebaseRowSchema } from './codebase';
export type { Codebase } from './codebase';

// Session
export { sessionRowSchema, sessionMetadataSchema, SESSION_TRANSITION_REASONS } from './session';
export type { Session, SessionMetadata, TransitionTrigger } from './session';

// WorkflowEvent
export { workflowEventRowSchema } from './workflow-event';
export type { WorkflowEventRow } from './workflow-event';

// EnvVar
export { codebaseEnvVarSchema } from './env-var';
export type { CodebaseEnvVar } from './env-var';

// WorkflowRun requests and dashboard types
export {
  dashboardWorkflowRunSchema,
  listDashboardRunsOptionsSchema,
  dashboardRunsResultSchema,
  signalWorkflowWaitRequestSchema,
} from './workflow-run';
export type {
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
  DashboardRunsResult,
  SignalWorkflowWaitRequest,
} from './workflow-run';
