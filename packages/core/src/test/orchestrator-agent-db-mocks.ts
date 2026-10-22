/** Fake implementations of core's database modules; the harness registers them as module mocks. */
import { mock } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type * as ConversationDb from '../db/conversations';
import type * as CodebaseDb from '../db/codebases';
import type * as SessionDb from '../db/sessions';
import type * as WorkflowDb from '../db/workflows';
import type * as WorkflowEventDb from '../db/workflow-events';
import type * as MessageDb from '../db/messages';
import type * as UserProviderKeyStore from '../db/user-provider-key-store';
import type { ResolvedCredential } from '../credentials/delivery';
import {
  makeIsolationEnvironment,
  makeMessage,
  type AgentIsolationEnvironment,
} from './orchestrator-agent-fixtures';

export const mockGetOrCreateConversation = mock<typeof ConversationDb.getOrCreateConversation>(() =>
  Promise.resolve({
    id: 'conv-1-db',
    platform_type: 'web',
    platform_conversation_id: 'conv-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  })
);
export const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>(() => Promise.resolve(null));
export const mockGetCodebaseEnvVars = mock(() => Promise.resolve({}));
export const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>(() =>
  Promise.resolve()
);
export const mockDetachConversationProject =
  mock<typeof ConversationDb.detachConversationProject>();
export const mockGetConversationByPlatformId = mock<
  typeof ConversationDb.getConversationByPlatformId
>(() => Promise.resolve(null));

export const mockListCodebases = mock<typeof CodebaseDb.listCodebases>(() => Promise.resolve([]));
export const mockCreateCodebase = mock<typeof CodebaseDb.createCodebase>(() =>
  Promise.resolve({
    id: 'new-codebase-id',
    name: 'test-project',
    repository_url: null,
    default_cwd: '/repos/test-project',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);
export const mockRepairCodebaseRegistration = mock<typeof CodebaseDb.repairCodebaseRegistration>(
  () => Promise.resolve()
);
export const mockUpdateCodebase = mock<typeof CodebaseDb.updateCodebase>(() => Promise.resolve());
export const mockDeleteCodebase = mock<typeof CodebaseDb.deleteCodebase>(() => Promise.resolve());
export class MockCodebaseNotFoundError extends Error {
  constructor(public codebaseId: string) {
    super(`Codebase ${codebaseId} not found`);
    this.name = 'CodebaseNotFoundError';
  }
}

export const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>(() =>
  Promise.resolve(null)
);
export const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>(() =>
  Promise.resolve()
);
export const mockUpdateSession = mock<typeof SessionDb.updateSession>(() => Promise.resolve());
export const mockTransitionSession = mock<typeof SessionDb.transitionSession>(() =>
  Promise.resolve({
    id: 'session-1',
    conversation_id: 'conv-1-db',
    codebase_id: null,
    ai_assistant_type: 'claude',
    assistant_session_id: null,
    active: true,
    metadata: {},
    started_at: new Date(),
    ended_at: null,
    parent_session_id: null,
    transition_reason: null,
    ended_reason: null,
  })
);
export class MockSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export const mockRegisterFolder = mock(async (path: string, name?: string) => ({
  codebaseId: 'folder-id',
  name: name ?? 'platform',
  defaultCwd: path,
  alreadyExisted: false,
}));
export const mockRegisterRepository = mock(
  async (path: string, options: { name?: string } = {}) => ({
    codebaseId: 'repo-id',
    name: options.name ?? 'repo',
    defaultCwd: path,
    alreadyExisted: false,
  })
);

export const mockGetPausedWorkflowRun = mock<typeof WorkflowDb.getPausedWorkflowRun>(() =>
  Promise.resolve(null)
);
export const mockFindResumableRunByParentConversation = mock<
  typeof WorkflowDb.findResumableRunByParentConversation
>(() => Promise.resolve(null));
export const mockUpdateWorkflowRun = mock<typeof WorkflowDb.updateWorkflowRun>(() =>
  Promise.resolve()
);
// approveWorkflow stamps the resolution atomically via this CAS (#2113), not
// updateWorkflowRun. Defaults to "won the race".
export const mockResolveApprovalGate = mock<typeof WorkflowDb.resolveApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);
// approveWorkflow (operations/workflow-operations, called by the NL approval
// path) re-reads the run via getWorkflowRun before recording the resolution.
export const mockGetWorkflowRunDb = mock<typeof WorkflowDb.getWorkflowRun>(() =>
  Promise.resolve(null)
);
// rejectWorkflow's terminal path (no on_reject staged) resolves + cancels in one CAS.
export const mockResolveAndCancelApprovalGate = mock<
  typeof WorkflowDb.resolveAndCancelApprovalGate
>(() => Promise.resolve({ resolved: true }));
// manage_run resolves every by-id action through this project-scoped prefix lookup.
export const mockFindWorkflowRunsByIdPrefix = mock<typeof WorkflowDb.findWorkflowRunsByIdPrefix>(
  () => Promise.resolve([])
);
export const mockListDashboardRuns = mock<typeof WorkflowDb.listDashboardRuns>(() =>
  Promise.resolve({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
  })
);
export class MockWorkflowNotResumableError extends Error {
  constructor(
    readonly runId: string,
    readonly currentStatus: WorkflowRun['status']
  ) {
    super(`Workflow run is not resumable (id: ${runId}, status: ${currentStatus}).`);
    this.name = 'WorkflowNotResumableError';
  }
}

export const mockCreateWorkflowEvent = mock<typeof WorkflowEventDb.createWorkflowEvent>(() =>
  Promise.resolve()
);

export const mockAddMessage = mock<typeof MessageDb.addMessage>((conversationId, role, content) =>
  Promise.resolve(makeMessage({ conversation_id: conversationId, role, content }))
);
export const mockGetRecentWorkflowResultMessages = mock<
  typeof MessageDb.getRecentWorkflowResultMessages
>(() => Promise.resolve([]));
export const mockAdoptionMetadata = mock<
  typeof import('../db/isolation-environments').updateMetadata
>(async () => {});
export const mockResumedEnvironment = mock(
  async (): Promise<ReturnType<typeof makeIsolationEnvironment> | null> => null
);
export const mockAdoptedEnvironment = mock(
  async (): Promise<AgentIsolationEnvironment | null> =>
    makeIsolationEnvironment({ working_path: '/wt/adopted' })
);

// The user's stored credentials: a usable credential, or the status a broken one reports.
type StoredFixture =
  | { provider: string; cred: ResolvedCredential }
  | {
      provider: string;
      status: Exclude<UserProviderKeyStore.StoredCredential, { state: 'usable' }>;
    };
export const mockStoredProviderCredentials = mock<(userId: string) => Promise<StoredFixture[]>>(
  async () => []
);
export const mockListUserProviderKeys = mock(async (userId: string) =>
  (await mockStoredProviderCredentials(userId)).map(row => ({
    provider: row.provider,
    kind: 'cred' in row ? row.cred.kind : ('api_key' as const),
    label: null,
  }))
);

// Per-user AI prefs (Phase 3). Default: empty — config-only behavior.
export const mockGetUserAiPrefsDb = mock(
  async (_userId: string) => ({}) as Record<string, unknown>
);
