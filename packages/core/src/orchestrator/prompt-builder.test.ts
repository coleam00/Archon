import { describe, test, expect } from 'bun:test';
import {
  buildRoutingRulesWithProject,
  formatWorkflowContextSection,
  getAssistWorkflowName,
} from './prompt-builder';

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

  test('uses Codex assist workflow when assistant type is codex', () => {
    const rules = buildRoutingRulesWithProject('my-project', 'codex');

    expect(rules).toContain('**archon-assist-codex**');
    expect(rules).toContain('/invoke-workflow archon-assist-codex --project my-project');
  });
});

describe('getAssistWorkflowName', () => {
  test('returns Codex assist workflow for codex assistant', () => {
    expect(getAssistWorkflowName('codex')).toBe('archon-assist-codex');
  });

  test('returns Claude assist workflow by default', () => {
    expect(getAssistWorkflowName('claude')).toBe('archon-assist');
    expect(getAssistWorkflowName()).toBe('archon-assist');
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
