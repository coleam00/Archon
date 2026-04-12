import { describe, test, expect } from 'bun:test';
import { buildRoutingRulesWithProject, getAssistWorkflowName } from './prompt-builder';

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
