/**
 * Core Zod schemas and derived types.
 *
 * All data-shape types are derived from schemas via `z.infer<typeof schema>`.
 * Import `z` from `@hono/zod-openapi` in all schema files (project convention).
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

// Codebase
export { codebaseRowSchema } from './codebase';
export type { Codebase } from './codebase';

// Session
export { sessionRowSchema, sessionMetadataSchema } from './session';
export type { Session, SessionMetadata } from './session';

// WorkflowEvent
export { workflowEventRowSchema } from './workflow-event';
export type { WorkflowEventRow } from './workflow-event';

// EnvVar
export { codebaseEnvVarSchema } from './env-var';
export type { CodebaseEnvVar } from './env-var';

// WorkflowRun (dashboard types)
export {
  dashboardWorkflowRunSchema,
  listDashboardRunsOptionsSchema,
  dashboardRunsResultSchema,
} from './workflow-run';
export type {
  DashboardWorkflowRun,
  ListDashboardRunsOptions,
  DashboardRunsResult,
} from './workflow-run';
