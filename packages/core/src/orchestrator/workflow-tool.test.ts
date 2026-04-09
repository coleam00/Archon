/**
 * Tests for workflow-tool.ts
 *
 * Tests the buildWorkflowMcpServer factory and the invoke_workflow tool handler.
 *
 * Mock setup MUST occur before any import of the module under test.
 */

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import type { Codebase, Conversation } from '../types';
import type { WorkflowDefinition } from '@archon/workflows';

// ─── Mock setup (ALL mocks must come before the module under test import) ────

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

mock.module('@archon/workflows', () => ({
  findWorkflow: mock((name: string, workflows: WorkflowDefinition[]) =>
    workflows.find(w => w.name === name)
  ),
}));

// Capture the tool handler so tests can invoke it directly
let capturedHandler: ((args: Record<string, string>, extra: unknown) => Promise<unknown>) | null =
  null;
let capturedTools: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: mock((opts: { name: string; version?: string; tools?: unknown[] }) => {
    capturedTools = opts.tools ?? [];
    return { type: 'sdk', name: opts.name, instance: {} };
  }),
  tool: mock(
    (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: Record<string, string>, extra: unknown) => Promise<unknown>
    ) => {
      capturedHandler = handler;
      return { name, description, inputSchema: schema, handler };
    }
  ),
}));

// ─── Import module under test (AFTER all mocks) ───────────────────────────────

import { buildWorkflowMcpServer } from './workflow-tool';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkflow(name: string): WorkflowDefinition {
  return {
    name,
    description: `${name} workflow`,
    steps: [{ prompt: 'do the thing' }],
  } as unknown as WorkflowDefinition;
}

function makeCodebase(name: string, id = `id-${name}`): Codebase {
  return {
    id,
    name,
    repository_url: null,
    default_cwd: `/repos/${name}`,
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeConversation(id = 'conv-1'): Conversation {
  return {
    id,
    platform: 'slack',
    platform_conversation_id: 'slack-123',
    codebase_id: null,
    ai_assistant_type: 'claude',
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as Conversation;
}

function makePlatform() {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'slack' as const),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildWorkflowMcpServer', () => {
  const assistWorkflow = makeWorkflow('archon-assist');
  const fixWorkflow = makeWorkflow('archon-fix-github-issue-dag');
  const myProject = makeCodebase('remote-coding-agent');
  const orgProject = makeCodebase('mhooooo/remote-coding-agent');

  const workflows = [assistWorkflow, fixWorkflow];
  const codebases = [myProject, orgProject];

  let dispatchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    capturedHandler = null;
    capturedTools = [];
    dispatchMock = mock(() => Promise.resolve());
    mockLogger.error.mockClear();
  });

  function buildDeps(overrides: Partial<Parameters<typeof buildWorkflowMcpServer>[0]> = {}) {
    return {
      platform: makePlatform(),
      conversationId: 'conv-1',
      conversation: makeConversation(),
      codebases,
      workflows,
      isolationHints: undefined,
      dispatch: dispatchMock,
      ...overrides,
    };
  }

  // ─── Server shape ────────────────────────────────────────────────────────────

  test('returns McpSdkServerConfigWithInstance with type sdk', () => {
    const result = buildWorkflowMcpServer(buildDeps());

    expect(result).toBeDefined();
    expect((result as { type: string }).type).toBe('sdk');
    expect((result as { instance: unknown }).instance).toBeDefined();
  });

  test('registers exactly one tool named invoke_workflow', () => {
    buildWorkflowMcpServer(buildDeps());

    expect(capturedTools).toHaveLength(1);
    expect((capturedTools[0] as { name: string }).name).toBe('invoke_workflow');
  });

  // ─── Handler: workflow not found ─────────────────────────────────────────────

  test('returns error text when workflow_name is not found', async () => {
    buildWorkflowMcpServer(buildDeps());
    expect(capturedHandler).not.toBeNull();

    const result = await capturedHandler!(
      {
        workflow_name: 'nonexistent-workflow',
        project_name: 'remote-coding-agent',
        task_description: 'do something',
      },
      {}
    );

    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('nonexistent-workflow');
    expect(content[0].text).toContain('not found');
  });

  // ─── Handler: project not found ──────────────────────────────────────────────

  test('returns error text with available projects when project_name is not found', async () => {
    buildWorkflowMcpServer(buildDeps());
    expect(capturedHandler).not.toBeNull();

    const result = await capturedHandler!(
      {
        workflow_name: 'archon-assist',
        project_name: 'unknown-project',
        task_description: 'do something',
      },
      {}
    );

    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('unknown-project');
    expect(content[0].text).toContain('not found');
    // Should list available projects
    expect(content[0].text).toContain('remote-coding-agent');
  });

  // ─── Handler: success dispatch ───────────────────────────────────────────────

  test('calls dispatch once with correct codebase, workflow, and task description on success', async () => {
    buildWorkflowMcpServer(buildDeps());
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!(
      {
        workflow_name: 'archon-assist',
        project_name: 'remote-coding-agent',
        task_description: 'Fix issue #3',
      },
      {}
    );

    // Give the fire-and-forget promise a tick to resolve
    await new Promise(r => setTimeout(r, 0));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [calledCodebase, calledWorkflow, calledDesc] = (
      dispatchMock as { mock: { calls: unknown[][] } }
    ).mock.calls[0];
    expect((calledCodebase as Codebase).name).toBe('remote-coding-agent');
    expect((calledWorkflow as WorkflowDefinition).name).toBe('archon-assist');
    expect(calledDesc).toBe('Fix issue #3');
  });

  // ─── Handler: success text ───────────────────────────────────────────────────

  test('returns confirmation text with workflow name and project name on success', async () => {
    buildWorkflowMcpServer(buildDeps());
    expect(capturedHandler).not.toBeNull();

    const result = await capturedHandler!(
      {
        workflow_name: 'archon-fix-github-issue-dag',
        project_name: 'remote-coding-agent',
        task_description: 'Fix issue #5',
      },
      {}
    );

    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('archon-fix-github-issue-dag');
    expect(content[0].text).toContain('remote-coding-agent');
  });

  // ─── Handler: dispatch throws ────────────────────────────────────────────────

  test('does not throw when dispatch rejects — fire-and-forget catches the error', async () => {
    const failingDispatch = mock(() => Promise.reject(new Error('dispatch failed')));
    const platformMock = makePlatform();
    buildWorkflowMcpServer(buildDeps({ dispatch: failingDispatch, platform: platformMock }));
    expect(capturedHandler).not.toBeNull();

    // Handler should resolve without throwing
    const result = await capturedHandler!(
      {
        workflow_name: 'archon-assist',
        project_name: 'remote-coding-agent',
        task_description: 'do something',
      },
      {}
    );

    // Still returns confirmation (workflow was accepted)
    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('Dispatched');

    // Give the fire-and-forget .catch() a tick to run
    await new Promise(r => setTimeout(r, 0));

    // Error was caught and logged
    expect(mockLogger.error).toHaveBeenCalled();

    // User is notified of the failure (not silently dropped)
    expect(platformMock.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Failed to start workflow')
    );
  });

  // ─── Case-insensitive project matching ──────────────────────────────────────

  test('matches project by last path segment (owner/repo → repo)', async () => {
    buildWorkflowMcpServer(buildDeps());
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!(
      {
        workflow_name: 'archon-assist',
        project_name: 'remote-coding-agent',
        task_description: 'test',
      },
      {}
    );

    await new Promise(r => setTimeout(r, 0));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  test('matches org-qualified codebase by short name (mhooooo/remote-coding-agent → remote-coding-agent)', async () => {
    buildWorkflowMcpServer(buildDeps({ codebases: [orgProject] }));
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!(
      {
        workflow_name: 'archon-assist',
        project_name: 'remote-coding-agent',
        task_description: 'test',
      },
      {}
    );

    await new Promise(r => setTimeout(r, 0));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [calledCodebase] = (dispatchMock as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((calledCodebase as Codebase).name).toBe('mhooooo/remote-coding-agent');
  });

  test('matches project case-insensitively', async () => {
    buildWorkflowMcpServer(buildDeps({ codebases: [myProject] }));
    expect(capturedHandler).not.toBeNull();

    await capturedHandler!(
      {
        workflow_name: 'archon-assist',
        project_name: 'REMOTE-CODING-AGENT',
        task_description: 'test',
      },
      {}
    );

    await new Promise(r => setTimeout(r, 0));

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const [calledCodebase] = (dispatchMock as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((calledCodebase as Codebase).name).toBe('remote-coding-agent');
  });
});
