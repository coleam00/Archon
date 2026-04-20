import { describe, test, expect } from 'bun:test';
import {
  buildRoutingRulesWithProject,
  buildOrchestratorPrompt,
  buildProjectScopedPrompt,
  formatWorkflowContextSection,
} from './prompt-builder';
import type { Codebase } from '../types';

describe('buildRoutingRulesWithProject', () => {
  test('routing rules include --prompt in invocation format', () => {
    const rules = buildRoutingRulesWithProject();

    expect(rules).toContain('--prompt');
    expect(rules).toContain('self-contained task description');
  });

  test('routing rules include --prompt with project-scoped prompt', () => {
    const rules = buildRoutingRulesWithProject('my-project');

    expect(rules).toContain('--prompt');
    expect(rules).toContain('my-project');
  });

  test('invocation format line includes exact --prompt flag syntax', () => {
    const rules = buildRoutingRulesWithProject();

    // The format template must include --prompt as part of the command, not just in prose
    expect(rules).toContain(
      '/invoke-workflow {workflow-name} --project {project-name} --prompt "{task description}"'
    );
  });

  test('rules state prompt must be self-contained with no conversation knowledge', () => {
    const rules = buildRoutingRulesWithProject();

    expect(rules).toContain('NO knowledge of the conversation history');
  });
});

describe('formatWorkflowContextSection', () => {
  test('returns empty string for empty results array', () => {
    expect(formatWorkflowContextSection([])).toBe('');
  });

  test('includes section header for non-empty results', () => {
    const result = formatWorkflowContextSection([
      { workflowName: 'plan', runId: 'run-1', summary: 'Created implementation plan.' },
    ]);
    expect(result).toContain('## Recent Workflow Results');
    expect(result).toContain('Use this context to answer follow-up questions');
  });

  test('formats each result with workflowName and runId', () => {
    const result = formatWorkflowContextSection([
      { workflowName: 'implement', runId: 'abc-123', summary: 'Added auth module.' },
    ]);
    expect(result).toContain('**implement** (run: abc-123)');
    expect(result).toContain('Added auth module.');
  });

  test('formats multiple results sequentially', () => {
    const results = [
      { workflowName: 'plan', runId: 'run-1', summary: 'Plan done.' },
      { workflowName: 'implement', runId: 'run-2', summary: 'Implement done.' },
    ];
    const result = formatWorkflowContextSection(results);
    expect(result).toContain('**plan**');
    expect(result).toContain('**implement**');
  });

  test('output does not end with trailing whitespace', () => {
    const result = formatWorkflowContextSection([
      { workflowName: 'assist', runId: 'r-1', summary: 'Done.' },
    ]);
    expect(result).toBe(result.trimEnd());
  });
});

// ─── Docker path injection ────────────────────────────────────────────────────

const makeCb = (overrides: Partial<Codebase> = {}): Codebase => ({
  id: 'cb-1',
  name: 'my-project',
  default_cwd: '/path',
  ai_assistant_type: 'claude',
  commands: {},
  repository_url: null,
  ...overrides,
});

describe('workspacesPath injection (Docker path fix, #1237)', () => {
  test('buildRoutingRulesWithProject uses provided workspacesPath in clone instructions', () => {
    const rules = buildRoutingRulesWithProject(undefined, '/.archon/workspaces');
    expect(rules).toContain('/.archon/workspaces/{owner}/{repo}/source');
    expect(rules).not.toContain('~/.archon/workspaces');
  });

  test('buildOrchestratorPrompt defaults to ~/.archon/workspaces when path omitted', () => {
    const prompt = buildOrchestratorPrompt([], []);
    expect(prompt).toContain('~/.archon/workspaces/');
  });

  test('buildOrchestratorPrompt uses injected Docker path', () => {
    const prompt = buildOrchestratorPrompt([], [], '/.archon/workspaces');
    expect(prompt).toContain('/.archon/workspaces/');
    expect(prompt).not.toContain('~/.archon/workspaces');
  });

  test('buildProjectScopedPrompt uses injected Docker path', () => {
    const prompt = buildProjectScopedPrompt(makeCb(), [], [], '/.archon/workspaces');
    expect(prompt).toContain('/.archon/workspaces/');
    expect(prompt).not.toContain('~/.archon/workspaces');
  });
});
