/** Row, config and adapter builders shared by the handleMessage suites. */
import { mock } from 'bun:test';
import type { Codebase, Conversation, IPlatformAdapter } from '../types';
import type { MergedConfig } from '../config/config-types';
import type { MessageRow } from '../schemas/message';
import type { Session } from '../schemas/session';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type * as IsolationResolver from '../orchestrator/dispatch/isolation-resolver';

/** The only `Codebase` literal in this file. Every variant is an override of it. */
export function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'codebase-1',
    name: 'test-repo',
    repository_url: null,
    default_cwd: '/repos/test-repo',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Positional form for tests that identify a project by name: the name drives id and cwd. */
export function makeNamedCodebase(name: string, id = `id-${name}`): Codebase {
  return makeCodebase({ id, name, default_cwd: `/repos/${name}` });
}

/** The only `WorkflowRun` literal in this file. Every variant is an override of it. */
export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'codebase-1',
    status: 'paused',
    outcome: null,
    user_message: 'original prompt',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/repos/test-repo',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...overrides,
  };
}

export function makePlatform() {
  return {
    capabilities: { messagePersistence: 'adapter', defaultWorkflowDispatch: 'background' } as const,
    sendMessage: mock<IPlatformAdapter['sendMessage']>(() => Promise.resolve()),
    ensureThread: mock<NonNullable<IPlatformAdapter['ensureThread']>>(id => Promise.resolve(id)),
    getStreamingMode: mock<IPlatformAdapter['getStreamingMode']>(() => 'batch'),
    getPlatformType: mock<IPlatformAdapter['getPlatformType']>(() => 'web'),
    start: mock<IPlatformAdapter['start']>(() => Promise.resolve()),
    stop: mock<IPlatformAdapter['stop']>(() => {}),
  } satisfies IPlatformAdapter;
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    // DB primary key deliberately differs from platform_conversation_id — the
    // real schemas always generate `id` independently, and identical defaults
    // masked the /setproject platform-id bug (id-conflating tests passed
    // against the broken code).
    id: 'conv-1-db',
    platform_type: 'web',
    platform_conversation_id: 'conv-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: 'Test Conversation',
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<MergedConfig> = {}): MergedConfig {
  return {
    botName: 'Archon',
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    streaming: { telegram: 'stream', discord: 'batch', slack: 'batch' },
    attentionNotices: [],
    concurrency: { maxConversations: 10 },
    workflows: {
      autoResumeOnQuotaReset: false,
    },
    commands: { autoLoad: true },
    defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    envVars: {},
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'message-1',
    conversation_id: 'conv-1-db',
    role: 'assistant',
    content: 'test message',
    metadata: '{}',
    user_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
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
    ...overrides,
  };
}

export type AgentIsolationEnvironment = Extract<
  Awaited<ReturnType<typeof IsolationResolver.validateAndResolveIsolation>>,
  { status: 'new' }
>['env'];

export function makeIsolationEnvironment(
  overrides: Partial<AgentIsolationEnvironment> = {}
): AgentIsolationEnvironment {
  return {
    id: 'env-1',
    codebase_id: 'codebase-1',
    workflow_type: 'task',
    workflow_id: 'workflow-1',
    provider: 'worktree',
    working_path: '/wt/from-branch',
    branch_name: 'feature/adopted',
    status: 'active',
    created_at: new Date('2026-01-01'),
    created_by_platform: 'web',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

/** The sync suites need a codebase with a remote; nothing else differs. */
export function makeCodebaseForSync(): Codebase {
  return makeCodebase({ repository_url: 'https://github.com/test/repo' });
}

export function makeDispatchConversation(overrides: Partial<Conversation> = {}) {
  return makeConversation({ codebase_id: 'codebase-1', ...overrides });
}

/** A chat-style adapter that runs fresh workflows in the foreground. */
export function makeForegroundPlatform() {
  return {
    ...makePlatform(),
    capabilities: {
      messagePersistence: 'adapter',
      defaultWorkflowDispatch: 'foreground',
    } as const,
  };
}
