import { describe, test, expect } from 'bun:test';
import {
  conversationRowSchema,
  messageRowSchema,
  codebaseRowSchema,
  userRowSchema,
  userIdentityRowSchema,
  sessionRowSchema,
  sessionMetadataSchema,
  workflowEventRowSchema,
  codebaseEnvVarSchema,
  dashboardWorkflowRunSchema,
  listDashboardRunsOptionsSchema,
  dashboardRunsResultSchema,
  identityPlatformSchema,
} from './index';

describe('core schemas', () => {
  // -----------------------------------------------------------------------
  // conversationRowSchema
  // -----------------------------------------------------------------------
  test('conversationRowSchema accepts a valid row with Date objects', () => {
    const result = conversationRowSchema.safeParse({
      id: 'conv-1',
      platform_type: 'web',
      platform_conversation_id: 'web-123',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      ai_assistant_type: 'claude',
      title: null,
      hidden: false,
      deleted_at: null,
      last_activity_at: new Date(),
      user_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  test('conversationRowSchema rejects string dates (z.date() requires Date instances)', () => {
    const result = conversationRowSchema.safeParse({
      id: 'conv-1',
      platform_type: 'web',
      platform_conversation_id: 'web-123',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      ai_assistant_type: 'claude',
      title: null,
      hidden: false,
      deleted_at: null,
      last_activity_at: '2025-06-01T12:00:00.000Z',
      user_id: null,
      created_at: '2025-06-01T12:00:00.000Z',
      updated_at: '2025-06-01T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  test('conversationRowSchema rejects missing required fields', () => {
    const result = conversationRowSchema.safeParse({
      id: 'conv-1',
      platform_type: 'web',
    });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // messageRowSchema
  // -----------------------------------------------------------------------
  test('messageRowSchema accepts a valid row', () => {
    const result = messageRowSchema.safeParse({
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'assistant',
      content: 'Hello',
      metadata: '{}',
      user_id: null,
      created_at: '2025-06-01T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  test('messageRowSchema rejects invalid role', () => {
    const result = messageRowSchema.safeParse({
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'invalid',
      content: 'Hello',
      metadata: '{}',
      user_id: null,
      created_at: '2025-06-01T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // codebaseRowSchema
  // -----------------------------------------------------------------------
  test('codebaseRowSchema accepts a valid row', () => {
    const result = codebaseRowSchema.safeParse({
      id: 'cb-1',
      name: 'my-project',
      repository_url: 'https://github.com/user/repo',
      default_cwd: '/home/user/projects/my-project',
      ai_assistant_type: 'claude',
      commands: { plan: { path: '/cmds/plan.md', description: 'Plan' } },
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // userRowSchema + userIdentityRowSchema
  // -----------------------------------------------------------------------
  test('userRowSchema accepts a valid row', () => {
    const result = userRowSchema.safeParse({
      id: 'user-1',
      display_name: 'Alice',
      email: 'alice@example.com',
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  test('userIdentityRowSchema accepts a valid row', () => {
    const result = userIdentityRowSchema.safeParse({
      id: 'id-1',
      user_id: 'user-1',
      platform: 'web',
      platform_user_id: 'web-123',
      platform_display_name: 'Alice',
      created_at: new Date(),
    });
    expect(result.success).toBe(true);
  });

  test('identityPlatformSchema rejects invalid platform', () => {
    const result = identityPlatformSchema.safeParse('invalid_platform');
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // sessionRowSchema + sessionMetadataSchema
  // -----------------------------------------------------------------------
  test('sessionRowSchema accepts a valid row', () => {
    const result = sessionRowSchema.safeParse({
      id: 'sess-1',
      conversation_id: 'conv-1',
      codebase_id: null,
      ai_assistant_type: 'claude',
      assistant_session_id: null,
      active: true,
      metadata: { lastCommand: 'plan' },
      started_at: new Date(),
      ended_at: null,
      parent_session_id: null,
      transition_reason: null,
      ended_reason: null,
    });
    expect(result.success).toBe(true);
  });

  test('sessionMetadataSchema allows extra keys via passthrough', () => {
    const result = sessionMetadataSchema.safeParse({ lastCommand: 'plan', extra: true });
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // workflowEventRowSchema
  // -----------------------------------------------------------------------
  test('workflowEventRowSchema accepts a valid row', () => {
    const result = workflowEventRowSchema.safeParse({
      id: 'evt-1',
      workflow_run_id: 'run-1',
      event_type: 'step_started',
      step_index: 0,
      step_name: 'plan',
      data: {},
      created_at: '2025-06-01T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // codebaseEnvVarSchema
  // -----------------------------------------------------------------------
  test('codebaseEnvVarSchema accepts a valid row', () => {
    const result = codebaseEnvVarSchema.safeParse({
      id: 'env-1',
      codebase_id: 'cb-1',
      key: 'API_KEY',
      value: 'secret',
      created_at: '2025-06-01T12:00:00.000Z',
      updated_at: '2025-06-01T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // dashboardWorkflowRunSchema
  // -----------------------------------------------------------------------
  test('dashboardWorkflowRunSchema preserves all base workflowRun fields', () => {
    const result = dashboardWorkflowRunSchema.safeParse({
      id: 'run-1',
      workflow_name: 'deploy',
      conversation_id: 'conv-1',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'running',
      user_message: 'deploy please',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: new Date(),
      working_path: null,
      user_id: null,
      // dashboard extensions
      codebase_name: 'my-repo',
      platform_type: 'web',
      worker_platform_id: null,
      parent_platform_id: null,
      current_step_name: null,
      total_steps: null,
      current_step_status: null,
      agents_completed: null,
      agents_failed: null,
      agents_total: null,
    });
    expect(result.success).toBe(true);
  });

  test('dashboardWorkflowRunSchema rejects invalid status', () => {
    const result = dashboardWorkflowRunSchema.safeParse({
      id: 'run-1',
      workflow_name: 'deploy',
      conversation_id: 'conv-1',
      parent_conversation_id: null,
      codebase_id: null,
      status: 'invalid_status',
      user_message: 'deploy please',
      metadata: {},
      started_at: new Date(),
      completed_at: null,
      last_activity_at: new Date(),
      working_path: null,
      user_id: null,
      codebase_name: 'my-repo',
      platform_type: 'web',
      worker_platform_id: null,
      parent_platform_id: null,
      current_step_name: null,
      total_steps: null,
      current_step_status: null,
      agents_completed: null,
      agents_failed: null,
      agents_total: null,
    });
    expect(result.success).toBe(false);
  });

  // -----------------------------------------------------------------------
  // listDashboardRunsOptionsSchema
  // -----------------------------------------------------------------------
  test('listDashboardRunsOptionsSchema accepts valid options', () => {
    const result = listDashboardRunsOptionsSchema.safeParse({
      status: 'running',
      codebaseId: 'cb-1',
      search: 'deploy',
      limit: 50,
      offset: 0,
    });
    expect(result.success).toBe(true);
  });

  test('listDashboardRunsOptionsSchema rejects invalid status', () => {
    const result = listDashboardRunsOptionsSchema.safeParse({
      status: 'invalid_status',
    });
    expect(result.success).toBe(false);
  });

  test('listDashboardRunsOptionsSchema accepts empty object', () => {
    const result = listDashboardRunsOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------------
  // dashboardRunsResultSchema
  // -----------------------------------------------------------------------
  test('dashboardRunsResultSchema accepts valid result', () => {
    const result = dashboardRunsResultSchema.safeParse({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
    });
    expect(result.success).toBe(true);
  });
});
