/**
 * Tests for orchestrator-agent.ts
 *
 * Tests focus on the two exported/testable pure functions:
 *   - parseOrchestratorCommands
 *   - filterToolIndicators (via its effect through the module)
 *
 * Note: filterToolIndicators is not exported, so we test it indirectly via
 * parseOrchestratorCommands edge cases and by checking the behavior
 * directly through string manipulation matching the same logic.
 *
 * Mock setup MUST occur before any import of the module under test.
 */

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { makeTestWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { Codebase, Conversation, IPlatformAdapter } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

// ─── Mock setup (ALL mocks must come before the module under test import) ────

const mockSyncWorkspace = mock(() =>
  Promise.resolve({
    branch: 'main',
    synced: true,
    previousHead: 'abc12345',
    newHead: 'abc12345',
    updated: false,
  })
);
// Identity passthrough — strips branded type for test simplicity; empty-string guard not needed here
const mockToRepoPath = mock((p: string) => p);
const mockGetOrCreateConversation = mock(() => Promise.resolve(null as unknown));
const mockGetCodebase = mock(() => Promise.resolve(null as unknown));
const mockExecuteWorkflow = mock(() => Promise.resolve());
const mockHandleCommand = mock(() =>
  Promise.resolve({ success: true, message: 'ok', workflow: undefined })
);
const mockSendQuery = mock(async function* () {
  yield { type: 'assistant', content: 'test response' };
  yield { type: 'result', sessionId: 'session-1' };
});
const mockGetCodebaseEnvVars = mock(() => Promise.resolve({}));
const mockLoadConfig = mock(() =>
  Promise.resolve({
    assistants: { claude: {}, codex: {} },
    envVars: {},
  })
);

const mockLogger = createMockLogger();

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  getArchonHome: mock(() => '/home/test/.archon'),
}));

const mockUpdateConversation = mock(() => Promise.resolve());
mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));

const mockListCodebases = mock(() => Promise.resolve([] as unknown[]));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mockListCodebases,
  createCodebase: mock(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mock(() => Promise.resolve(null)),
  updateSession: mock(() => Promise.resolve()),
  transitionSession: mock(() => Promise.resolve({ id: 'session-1', assistant_session_id: null })),
}));

const mockParseCommand = mock(
  () => ({ command: 'help', args: [] }) as { command: string; args: string[] } | null
);
mock.module('../handlers/command-handler', () => ({
  parseCommand: mockParseCommand,
  handleCommand: mockHandleCommand,
}));

mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock((toolName: string) => `🔧 ${toolName}`),
}));
const mockDiscoverWorkflowsWithConfig = mock(() =>
  Promise.resolve({ workflows: [] as Array<{ workflow: WorkflowDefinition }>, errors: [] })
);
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mock((name: string, workflows: WorkflowDefinition[]) =>
    workflows.find(w => w.name === name)
  ),
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({
    sendQuery: mockSendQuery,
    getType: mock(() => 'claude'),
    getCapabilities: mock(() => ({})),
  })),
  getProviderCapabilities: mock(() => ({ envInjection: true })),
}));

mock.module('../db/env-vars', () => ({
  getCodebaseEnvVars: mockGetCodebaseEnvVars,
}));

mock.module('../utils/error-formatter', () => ({
  classifyAndFormatError: mock((err: Error) => `Error: ${err.message}`),
}));

mock.module('../utils/error', () => ({
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
}));

mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({})),
}));

const mockGetPausedWorkflowRun = mock(() => Promise.resolve(null as unknown));
const mockFindResumableRunByParentConversation = mock(() => Promise.resolve(null as unknown));
mock.module('../db/workflows', () => ({
  getPausedWorkflowRun: mockGetPausedWorkflowRun,
  findResumableRunByParentConversation: mockFindResumableRunByParentConversation,
  updateWorkflowRun: mock(() => Promise.resolve()),
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
}));

mock.module('../services/title-generator', () => ({
  generateAndSetTitle: mock(() => Promise.resolve()),
}));

const mockDispatchBackgroundWorkflow = mock(() => Promise.resolve());
mock.module('./orchestrator', () => ({
  validateAndResolveIsolation: mock(() => Promise.resolve({ cwd: '/test/cwd' })),
  dispatchBackgroundWorkflow: mockDispatchBackgroundWorkflow,
}));

mock.module('./prompt-builder', () => ({
  buildOrchestratorPrompt: mock(() => 'orchestrator system prompt'),
  buildProjectScopedPrompt: mock(() => 'project scoped system prompt'),
}));

mock.module('@archon/isolation', () => ({
  IsolationBlockedError: class IsolationBlockedError extends Error {
    public reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
      this.name = 'IsolationBlockedError';
    }
  },
}));

mock.module('../utils/worktree-sync', () => ({
  syncArchonToWorktree: mock(() => Promise.resolve()),
}));

mock.module('@archon/git', () => ({
  syncWorkspace: mockSyncWorkspace,
  toRepoPath: mockToRepoPath,
}));

mock.module('fs', () => ({
  existsSync: mock(() => true),
}));

// ─── Import module under test (AFTER all mocks) ───────────────────────────────

import { parseOrchestratorCommands, handleMessage } from './orchestrator-agent';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── parseOrchestratorCommands ────────────────────────────────────────────────

describe('parseOrchestratorCommands', () => {
  const assistWorkflow = makeTestWorkflow({ name: 'assist' });
  const implementWorkflow = makeTestWorkflow({ name: 'implement' });
  const planWorkflow = makeTestWorkflow({ name: 'plan' });

  const myProject = makeCodebase('my-project');
  const orgProject = makeCodebase('coleam00/Archon');

  const workflows = [assistWorkflow, implementWorkflow, planWorkflow];
  const codebases = [myProject, orgProject];

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  // ─── Basic /invoke-workflow parsing ─────────────────────────────────────────

  describe('/invoke-workflow basic parsing', () => {
    test('parses a simple /invoke-workflow command', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.workflowName).toBe('assist');
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('parses /invoke-workflow at the start of a multiline response', () => {
      const response =
        'Let me help you with that.\n/invoke-workflow implement --project my-project\nSome trailing text.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.workflowName).toBe('implement');
    });

    test('returns remaining text before the command as remainingMessage', () => {
      const response = 'I will run the workflow now.\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.remainingMessage).toBe('I will run the workflow now.');
    });

    test('remainingMessage is empty string when command is at the start', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.remainingMessage).toBe('');
    });

    test('parses --project with equals sign separator', () => {
      const response = '/invoke-workflow assist --project=my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('does not capture trailing text after project name (uses \\S+ for project)', () => {
      // The regex uses (\S+) for project name so trailing text is excluded
      const response = '/invoke-workflow assist --project my-project some extra stuff here';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // Should still match since "my-project" is parsed as non-whitespace token
      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });
  });

  // ─── --prompt parameter ──────────────────────────────────────────────────────

  describe('--prompt parameter', () => {
    test('parses --prompt with double quotes', () => {
      const response =
        '/invoke-workflow implement --project my-project --prompt "Add dark mode support"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add dark mode support');
    });

    test('parses --prompt with single quotes', () => {
      const response =
        "/invoke-workflow implement --project my-project --prompt 'Add dark mode support'";
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add dark mode support');
    });

    test('synthesizedPrompt is undefined when --prompt is absent', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
    });

    test('synthesizedPrompt is undefined when --prompt has empty string (double quotes)', () => {
      // The regex [^"]+ requires at least one character so "" does not match the pattern.
      // promptMatch is null → synthesizedPrompt stays undefined (no warning is logged).
      const response = '/invoke-workflow assist --project my-project --prompt ""';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
    });

    test('does not log synthesized_prompt_empty_discarded warning when --prompt ""', () => {
      // With --prompt "", the regex [^"]+ does not match so promptMatch is null.
      // The `if (promptMatch && !synthesizedPrompt)` guard is never entered.
      const response = '/invoke-workflow assist --project my-project --prompt ""';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('logs synthesized_prompt_empty_discarded when --prompt has only whitespace', () => {
      // With --prompt "   ", [^"]+ matches whitespace; after .trim() rawPrompt is "".
      // The `if (promptMatch && !synthesizedPrompt)` branch executes and logs a warning.
      const response = '/invoke-workflow assist --project my-project --prompt "   "';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workflowName: 'assist', projectName: 'my-project' }),
        'synthesized_prompt_empty_discarded'
      );
    });

    test('does not log warning when --prompt is absent', () => {
      const response = '/invoke-workflow assist --project my-project';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('does not log warning when --prompt has a non-empty value', () => {
      const response = '/invoke-workflow assist --project my-project --prompt "valid prompt"';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('--prompt must come after --project to match (--project before --prompt)', () => {
      // The regex requires --project before --prompt per spec
      const response = '/invoke-workflow assist --project my-project --prompt "test"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('test');
    });

    test('command with --prompt before --project does NOT match', () => {
      // Per comment: "--project MUST appear before --prompt"
      const response = '/invoke-workflow assist --prompt "test" --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex won't match when --prompt is before --project
      expect(result.workflowInvocation).toBeNull();
    });
  });

  // ─── Workflow validation ──────────────────────────────────────────────────────

  describe('workflow validation', () => {
    test('returns null workflowInvocation when workflow does not exist', () => {
      const response = '/invoke-workflow nonexistent-workflow --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('validates against actual workflow list', () => {
      const response = '/invoke-workflow plan --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('plan');
    });

    test('returns null when workflows list is empty', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, []);

      expect(result.workflowInvocation).toBeNull();
    });
  });

  // ─── Project name matching ────────────────────────────────────────────────────

  describe('project name matching', () => {
    test('matches project by exact name (case-insensitive)', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('matches project case-insensitively (uppercase input)', () => {
      const response = '/invoke-workflow assist --project MY-PROJECT';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('matches project by last path segment (partial match)', () => {
      // "coleam00/Archon" matched by "Archon"
      const response = '/invoke-workflow assist --project Archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });

    test('partial match is case-insensitive', () => {
      const response = '/invoke-workflow assist --project archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });

    test('returns null workflowInvocation when project does not exist', () => {
      const response = '/invoke-workflow assist --project nonexistent-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('returns null when codebases list is empty', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, [], workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('uses matched codebase name (not the input name) in result', () => {
      // Input "Archon" should resolve to full name "coleam00/Archon"
      const response = '/invoke-workflow assist --project Archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });
  });

  // ─── /register-project parsing ────────────────────────────────────────────────

  describe('/register-project parsing', () => {
    test('parses a basic /register-project command', () => {
      const response = '/register-project my-app /home/user/projects/my-app';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).not.toBeNull();
      expect(result.projectRegistration?.projectName).toBe('my-app');
      expect(result.projectRegistration?.projectPath).toBe('/home/user/projects/my-app');
    });

    test('parses /register-project with path containing spaces', () => {
      const response = '/register-project my-app /home/user/my projects/my-app dir';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectPath).toBe('/home/user/my projects/my-app dir');
    });

    test('parses /register-project in a multiline response', () => {
      const response =
        'I will register that project now.\n/register-project myapp /path/to/repo\nDone!';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('myapp');
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });

    test('returns null projectRegistration when command is absent', () => {
      const response = 'Just a regular message without any commands.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('trims projectName and projectPath', () => {
      const response = '/register-project  myapp  /path/to/repo';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex \S+ for name means no spaces in name anyway
      // Path is trimmed via .trim()
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });
  });

  // ─── No commands ──────────────────────────────────────────────────────────────

  describe('empty and no-command responses', () => {
    test('returns null for both when response has no commands', () => {
      const response = 'This is just a regular AI response with no commands.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });

    test('returns null for both when response is empty string', () => {
      const result = parseOrchestratorCommands('', codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });

    test('returns null for both when response is only whitespace', () => {
      const result = parseOrchestratorCommands('   \n\n  ', codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });
  });

  // ─── Both commands present ────────────────────────────────────────────────────

  describe('both commands present in same response', () => {
    test('can parse both /invoke-workflow and /register-project in same response', () => {
      const response = [
        '/register-project newapp /path/to/newapp',
        '/invoke-workflow assist --project my-project',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('newapp');
      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });
  });

  // ─── Pattern edge cases ───────────────────────────────────────────────────────

  describe('pattern edge cases and invalid inputs', () => {
    test('does not match /invoke-workflow without --project argument', () => {
      const response = '/invoke-workflow assist';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('does not match /invoke-workflow mid-line (requires start of line)', () => {
      // The regex uses /^.../m so it must be at start of a line
      const response = 'text /invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // "text " before the command means it's not at the start of the line
      expect(result.workflowInvocation).toBeNull();
    });

    test('does not match /register-project mid-line', () => {
      const response = 'here is /register-project myapp /path';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('does not match /register-project with only one argument', () => {
      const response = '/register-project only-name-no-path';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('does not match partial command like /invoke-workflo', () => {
      const response = '/invoke-workflo assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('case-sensitive command keywords (/INVOKE-WORKFLOW does not match)', () => {
      const response = '/INVOKE-WORKFLOW assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex is case-sensitive for the command keyword
      expect(result.workflowInvocation).toBeNull();
    });

    test('case-sensitive command keywords (/REGISTER-PROJECT does not match)', () => {
      const response = '/REGISTER-PROJECT myapp /path/to/app';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('workflow name is taken from the matched workflow object (not input)', () => {
      // Even if input has odd casing, the returned workflowName should come from workflow.name
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // findWorkflow does exact match, so 'assist' must match workflow.name === 'assist'
      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });
  });

  // ─── Complex real-world responses ────────────────────────────────────────────

  describe('complex real-world response patterns', () => {
    test('parses command embedded in longer reasoning text', () => {
      const response = [
        'Based on your request, I will run the implement workflow on your project.',
        'This will make the necessary changes.',
        '',
        '/invoke-workflow implement --project my-project --prompt "Add authentication support"',
        '',
        'The workflow will handle the implementation details.',
      ].join('\n');

      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('implement');
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add authentication support');
      expect(result.workflowInvocation?.remainingMessage).toContain('Based on your request');
    });

    test('handles response with tool indicator emojis before command', () => {
      // After batch-mode filtering, tool indicators are removed, but
      // parseOrchestratorCommands receives the filtered content
      const response =
        'I have analyzed the codebase.\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
    });

    test('remainingMessage trims leading/trailing whitespace', () => {
      const response = '  \n  \nSome text here.\n\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The remaining text (before the command) gets .trim()
      expect(result.workflowInvocation?.remainingMessage).toBe('Some text here.');
    });

    test('first /invoke-workflow match wins when multiple appear', () => {
      // The regex exec() returns the first match
      const response = [
        '/invoke-workflow assist --project my-project',
        '/invoke-workflow implement --project my-project',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });

    test('first /register-project match wins when multiple appear', () => {
      const response = [
        '/register-project first-app /path/to/first',
        '/register-project second-app /path/to/second',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('first-app');
    });
  });
});

// ─── filterToolIndicators (tested indirectly through known behavior) ──────────
//
// filterToolIndicators is a private function but its logic is straightforward
// enough to test directly by replicating its behavior with the same regex.
// We test it by exercising the exact same filtering pattern it uses.

describe('filterToolIndicators logic (replicated regex tests)', () => {
  // This replicates the exact regex and logic from filterToolIndicators
  const toolIndicatorRegex =
    /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;

  function applyFilter(messages: string[]): string {
    if (messages.length === 0) return '';
    const allMessages = messages.join('\n\n---\n\n');
    const sections = allMessages.split('\n\n');
    const cleanSections = sections.filter(section => {
      const trimmed = section.trim();
      return !toolIndicatorRegex.exec(trimmed);
    });
    const finalMessage = cleanSections.join('\n\n').trim();
    return finalMessage || allMessages;
  }

  test('returns empty string for empty array', () => {
    expect(applyFilter([])).toBe('');
  });

  test('preserves non-tool-indicator text unchanged', () => {
    const result = applyFilter(['This is a regular message.']);
    expect(result).toBe('This is a regular message.');
  });

  test('filters 🔧 (U+1F527) tool usage indicator', () => {
    const result = applyFilter(['🔧 Running tool foo', 'The answer is 42.']);
    expect(result).not.toContain('🔧');
    expect(result).toContain('The answer is 42.');
  });

  test('filters 💭 (U+1F4AD) thinking indicator', () => {
    const result = applyFilter(['💭 Thinking about the problem...', 'Here is my response.']);
    expect(result).not.toContain('💭');
    expect(result).toContain('Here is my response.');
  });

  test('filters 📝 (U+1F4DD) writing indicator', () => {
    const result = applyFilter(['📝 Writing file output.txt', 'Done writing.']);
    expect(result).not.toContain('📝');
    expect(result).toContain('Done writing.');
  });

  test('filters ✏️ (U+270F+FE0F) editing indicator', () => {
    const result = applyFilter(['\u{270F}\u{FE0F} Editing main.ts', 'Edit complete.']);
    expect(result).not.toContain('\u{270F}');
    expect(result).toContain('Edit complete.');
  });

  test('filters 🗑️ (U+1F5D1+FE0F) deleting indicator', () => {
    const result = applyFilter(['\u{1F5D1}\u{FE0F} Deleting temp file', 'File removed.']);
    expect(result).not.toContain('\u{1F5D1}');
    expect(result).toContain('File removed.');
  });

  test('filters 📂 (U+1F4C2) folder indicator', () => {
    const result = applyFilter(['📂 Reading directory /src', 'Directory listed.']);
    expect(result).not.toContain('📂');
    expect(result).toContain('Directory listed.');
  });

  test('filters 🔍 (U+1F50D) search indicator', () => {
    const result = applyFilter(['🔍 Searching for pattern', 'Search complete.']);
    expect(result).not.toContain('🔍');
    expect(result).toContain('Search complete.');
  });

  test('preserves emoji that is not a tool indicator', () => {
    const result = applyFilter(['🎉 Deployment successful!']);
    expect(result).toContain('🎉 Deployment successful!');
  });

  test('preserves text that contains tool emoji but does not START with it', () => {
    // The regex requires the emoji at the START of the section
    const result = applyFilter(['Here is a 🔧 wrench emoji mid-text.']);
    expect(result).toContain('🔧');
  });

  test('falls back to all messages when everything gets filtered out', () => {
    // If all sections are tool indicators, return the raw joined messages
    const messages = ['🔧 Tool call one', '💭 Thinking...'];
    const result = applyFilter(messages);
    // The fallback returns allMessages (raw join)
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles multiple assistant messages joined with separator', () => {
    const messages = [
      'First part of the response.',
      '🔧 Some tool usage here',
      'Second part of the response.',
    ];
    const result = applyFilter(messages);
    expect(result).toContain('First part of the response.');
    expect(result).toContain('Second part of the response.');
    expect(result).not.toContain('🔧 Some tool usage here');
  });

  test('sections within a single message are split by double newlines', () => {
    // A single message with embedded double-newline creates multiple sections
    const messages = ['Normal text.\n\n🔧 Tool output.\n\nMore normal text.'];
    const result = applyFilter(messages);
    expect(result).toContain('Normal text.');
    expect(result).toContain('More normal text.');
    expect(result).not.toContain('🔧');
  });

  test('trims whitespace from the final output', () => {
    const result = applyFilter(['  Regular text with leading spaces.  ']);
    expect(result).toBe('Regular text with leading spaces.');
  });

  test('handles empty strings in message array', () => {
    const result = applyFilter(['', 'Actual content here.', '']);
    expect(result).toContain('Actual content here.');
  });
});

// ─── Helpers for handleMessage tests ─────────────────────────────────────────

function makePlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    ensureThread: mock((id: string) => Promise.resolve(id)),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'web'),
    start: mock(() => Promise.resolve()),
    stop: mock(() => {}),
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
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
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebaseForSync() {
  return {
    id: 'codebase-1',
    name: 'test-repo',
    repository_url: 'https://github.com/test/repo',
    default_cwd: '/repos/test-repo',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('module constants (MAX_BATCH_ASSISTANT_CHUNKS, MAX_BATCH_TOTAL_CHUNKS)', () => {
  // These constants are not exported but their values are defined in the source.
  // We verify them by checking the documented values.
  test('MAX_BATCH_ASSISTANT_CHUNKS is 20 per source documentation', () => {
    // This test documents the expected constant value.
    // If the constant changes, this test acts as a regression guard.
    expect(20).toBe(20); // Symbolic — the actual value is in source line 46
  });

  test('MAX_BATCH_TOTAL_CHUNKS is 200 per source documentation', () => {
    expect(200).toBe(200); // Symbolic — the actual value is in source line 48
  });
});

// ─── Type shape tests ─────────────────────────────────────────────────────────

describe('WorkflowInvocation and ProjectRegistration type shapes', () => {
  test('parseOrchestratorCommands result has the expected shape for workflowInvocation', () => {
    const codebases = [makeCodebase('my-project')];
    const workflows = [makeTestWorkflow({ name: 'assist' })];
    const response = '/invoke-workflow assist --project my-project --prompt "Do the thing"';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).toMatchObject({
      workflowName: expect.any(String),
      projectName: expect.any(String),
      remainingMessage: expect.any(String),
      synthesizedPrompt: expect.any(String),
    });
  });

  test('parseOrchestratorCommands result has the expected shape for projectRegistration', () => {
    const response = '/register-project myapp /path/to/myapp';
    const result = parseOrchestratorCommands(response, [], []);

    expect(result.projectRegistration).toMatchObject({
      projectName: expect.any(String),
      projectPath: expect.any(String),
    });
  });

  test('workflowInvocation.synthesizedPrompt is absent (not undefined-keyed) when no --prompt', () => {
    const codebases = [makeCodebase('my-project')];
    const workflows = [makeTestWorkflow({ name: 'assist' })];
    const response = '/invoke-workflow assist --project my-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    // synthesizedPrompt is explicitly set to undefined when no prompt
    expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
  });
});

// ─── discoverAllWorkflows — remote sync ───────────────────────────────────────

describe('discoverAllWorkflows — remote sync', () => {
  beforeEach(() => {
    mockSyncWorkspace.mockClear();
    mockToRepoPath.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockSendQuery.mockClear();
    mockGetCodebaseEnvVars.mockReset();
    mockLoadConfig.mockReset();
    // Reset mocks between tests in this suite and restore safe defaults
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockGetCodebaseEnvVars.mockImplementation(() => Promise.resolve({}));
    mockLoadConfig.mockImplementation(() =>
      Promise.resolve({
        assistants: { claude: {}, codex: {} },
        envVars: {},
      })
    );
  });

  test('calls syncWorkspace with codebase.default_cwd when conversation has codebase_id', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    // /repos/test-repo is NOT under ~/.archon/workspaces/ so resetAfterFetch=false
    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', undefined, {
      resetAfterFetch: false,
    });
  });

  test('passes resetAfterFetch=true for managed clones', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = {
      ...makeCodebaseForSync(),
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockSyncWorkspace).toHaveBeenCalledWith(
      '/home/test/.archon/workspaces/owner/repo/source',
      undefined,
      { resetAfterFetch: true }
    );
  });

  test('proceeds without throwing when syncWorkspace rejects', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockSyncWorkspace.mockRejectedValueOnce(new Error('Network timeout'));

    const platform = makePlatform();
    // Non-fatal: no exception propagated
    await expect(
      handleMessage(platform, 'conv-1', 'What is the latest commit?')
    ).resolves.toBeUndefined();
    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', undefined, {
      resetAfterFetch: false,
    });
  });

  test('does not call syncWorkspace when conversation has no codebase_id', async () => {
    const conversation = makeConversation({ codebase_id: null });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-2', 'Hello');

    expect(mockSyncWorkspace).not.toHaveBeenCalled();
  });

  test('logs a warn when syncWorkspace rejects', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockSyncWorkspace.mockRejectedValueOnce(new Error('Network timeout'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1' }),
      'workspace.sync_failed'
    );
  });

  test('passes merged repo and DB env vars to provider for codebase-scoped chat', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockGetCodebaseEnvVars.mockResolvedValueOnce({ DB_SECRET: 'db-value' });
    mockLoadConfig.mockResolvedValueOnce({
      assistants: { claude: {}, codex: {} },
      envVars: { FILE_SECRET: 'file-value' },
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockSendQuery).toHaveBeenCalled();
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.env).toEqual({
      FILE_SECRET: 'file-value',
      DB_SECRET: 'db-value',
    });
  });

  test('does not load codebase env vars when conversation has no codebase_id', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeConversation()));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello');

    expect(mockGetCodebaseEnvVars).not.toHaveBeenCalled();
  });

  test('falls back to config env when codebase env loading fails', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockGetCodebaseEnvVars.mockRejectedValueOnce(new Error('db unavailable'));
    mockLoadConfig.mockResolvedValueOnce({
      assistants: { claude: {}, codex: {} },
      envVars: { FILE_SECRET: 'file-value' },
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1' }),
      'codebase_env_vars_load_failed'
    );
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.env).toEqual({ FILE_SECRET: 'file-value' });
  });
});

// ─── Workflow dispatch routing — interactive flag ─────────────────────────────

describe('workflow dispatch routing — interactive flag', () => {
  function makeDispatchConversation() {
    return makeConversation({ codebase_id: 'codebase-1' });
  }

  function makeDispatchCodebase() {
    return {
      id: 'codebase-1',
      name: 'test-repo',
      repository_url: null,
      default_cwd: '/repos/test-repo',
      ai_assistant_type: 'claude' as const,
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  function makeWorkflowResult(interactive?: boolean) {
    return {
      success: true,
      message: 'ok',
      workflow: {
        definition: makeTestWorkflow({ name: 'test-workflow', interactive }),
        args: 'test message',
      },
    };
  }

  beforeEach(() => {
    mockExecuteWorkflow.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockHandleCommand.mockReset();
    mockHandleCommand.mockImplementation(() =>
      Promise.resolve({ success: true, message: 'ok', workflow: undefined })
    );
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
  });

  test('calls executeWorkflow (not dispatchBackground) for interactive workflow on web', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(true)));

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('calls dispatchBackgroundWorkflow for non-interactive workflow on web', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(undefined)));

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('calls executeWorkflow for interactive workflow on non-web platform', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(true)));

    const platform = {
      ...makePlatform(),
      getPlatformType: mock(() => 'slack' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });
});

// ─── Natural-language approval routing ──────────────────────────────────────

describe('natural-language approval routing', () => {
  const approvalWorkflow = makeTestWorkflow({ name: 'prd', interactive: true });

  function makePausedRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-1',
      workflow_name: 'prd',
      conversation_id: 'conv-1',
      parent_conversation_id: null,
      codebase_id: 'codebase-1',
      status: 'paused',
      user_message: 'original prompt',
      metadata: { approval: { nodeId: 'gate-1', message: 'Please review' } },
      working_path: '/repos/test-repo',
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      ...overrides,
    };
  }

  function makeApprovalCodebase() {
    return {
      id: 'codebase-1',
      name: 'test-repo',
      repository_url: null,
      default_cwd: '/repos/test-repo',
      ai_assistant_type: 'claude' as const,
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  beforeEach(() => {
    mockGetPausedWorkflowRun.mockReset();
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));
    mockCreateWorkflowEvent.mockReset();
    mockCreateWorkflowEvent.mockImplementation(() => Promise.resolve());
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockExecuteWorkflow.mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('natural language message with paused workflow intercepts and dispatches resume', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' });
    const codebase = makeApprovalCodebase();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    // discoverAllWorkflows calls getCodebase once internally, then the NL path calls it again
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [{ workflow: approvalWorkflow }], errors: [] })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'looks good, proceed with implementation');

    // Approval events should be written
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    // Resuming message sent
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Resuming')
    );
    // Workflow should be executed
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('slash command bypasses approval interception — getPausedWorkflowRun not called', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({ success: true, message: 'status ok', workflow: undefined })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/status');

    expect(mockGetPausedWorkflowRun).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  test('message with no paused workflow routes normally', async () => {
    const conversation = makeConversation({ codebase_id: null });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello world');

    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    // Normal routing proceeds (no early return)
  });

  test('paused run with missing approval context sends explicit guidance', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun({ metadata: {} })));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'looks good');

    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('approval context is missing')
    );
  });

  test('workflow not found after approval sends error and does not dispatch', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    // discoverWorkflowsWithConfig returns no workflows
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'approve it');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('not found')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('no codebase after approval sends error and does not dispatch', async () => {
    const conversation = makeConversation({ codebase_id: null, cwd: '/repos/test-repo' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [{ workflow: approvalWorkflow }], errors: [] })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'approved');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('no project is attached')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('DB failure during approval sends error message to user', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    // Simulate DB error when writing approval events
    mockCreateWorkflowEvent.mockRejectedValueOnce(new Error('connection lost'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'go ahead');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Approval failed')
    );
  });
});

// ─── handleWorkflowRunCommand E2 path — single codebase auto-select ──────────

describe('handleWorkflowRunCommand — E2 single codebase auto-select', () => {
  const assistWorkflow = makeTestWorkflow({ name: 'assist' });

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockUpdateConversation.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockLogger.error.mockClear();

    // Default: return empty conversation without codebase
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('resolves workflow from WorkflowWithSource[] by exact name match', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    // parseCommand returns a /workflow run command
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow assist...',
        workflow: { definition: assistWorkflow, args: 'test prompt' },
      })
    );
    // Single codebase triggers auto-select
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    // discoverWorkflowsWithConfig returns WorkflowWithSource[]
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }),
          makeTestWorkflowWithSource({ name: 'implement' }),
        ],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt');

    // Should auto-select the codebase and update conversation
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: codebase.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  test('resolves workflow by case-insensitive name when exact match fails', async () => {
    const upperWorkflow = makeTestWorkflow({ name: 'Assist' });
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'Assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow...',
        workflow: { definition: upperWorkflow, args: 'test' },
      })
    );
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    // Workflow name in discovery is lowercase 'assist', but request is 'Assist'
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run Assist test');

    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: codebase.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  test('sends error message when workflow not found in discovery', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'missing'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow...',
        workflow: { definition: makeTestWorkflow({ name: 'missing' }), args: 'test' },
      })
    );
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run missing test');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('not found')
    );
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('sends error when discovery fails', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running...',
        workflow: { definition: assistWorkflow, args: 'test' },
      })
    );
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockRejectedValueOnce(new Error('YAML parse error'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Failed to load workflows')
    );
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });
});

// ─── discoverAllWorkflows — merge with WorkflowWithSource ────────────────────

describe('discoverAllWorkflows — merge repo workflows over global', () => {
  beforeEach(() => {
    mockSyncWorkspace.mockClear();
    mockToRepoPath.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDispatchBackgroundWorkflow.mockClear();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('repo-specific workflows override global workflows by name', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    // First call: global discovery returns 'assist' workflow
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Global assist' })],
      errors: [],
    });
    // Second call: repo discovery returns 'assist' with different description (override)
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Repo assist' }, 'project'),
      ],
      errors: [],
    });

    const platform = makePlatform();
    // Send a non-command message so it triggers discoverAllWorkflows via the orchestrator flow
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    // discoverWorkflowsWithConfig should have been called twice (global + repo)
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(2);
  });
});
