import { describe, test, expect } from 'bun:test';
import {
  buildRoutingRulesWithProject,
  formatWorkflowContextSection,
  buildOrchestratorSystemAppend,
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

describe('buildOrchestratorSystemAppend', () => {
  const makeConversation = (codebaseId: string | null) =>
    ({
      id: 'conv-1',
      platform_type: 'web',
      platform_conversation_id: 'web-1',
      codebase_id: codebaseId,
      cwd: null,
      isolation_env_id: null,
      ai_assistant_type: 'claude',
      title: null,
      hidden: false,
      deleted_at: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }) as const;

  const codebases = [
    {
      id: 'cb-1',
      name: 'my-project',
      default_cwd: '/path/to/project',
      ai_assistant_type: 'claude',
      repository_url: null,
      commands: null,
    },
  ];

  const workflows = [
    {
      name: 'assist',
      description: 'General assistance',
      nodes: [{ id: 'step1', command: 'archon-assist', depends_on: [] }],
    },
  ] as unknown as import('@archon/workflows/schemas/workflow').WorkflowDefinition[];

  test('returns orchestrator prompt when no codebase is scoped', () => {
    const result = buildOrchestratorSystemAppend(makeConversation(null), codebases, workflows);
    expect(result).toContain('# Archon Orchestrator');
    expect(result).toContain('## Registered Projects');
    expect(result).toContain('my-project');
  });

  test('returns project-scoped prompt when codebase is scoped', () => {
    const result = buildOrchestratorSystemAppend(makeConversation('cb-1'), codebases, workflows);
    expect(result).toContain('# Archon Orchestrator');
    expect(result).toContain('## Active Project');
    expect(result).toContain('my-project');
  });

  test('falls back to orchestrator prompt when codebase_id does not match', () => {
    const result = buildOrchestratorSystemAppend(
      makeConversation('nonexistent'),
      codebases,
      workflows
    );
    expect(result).toContain('## Registered Projects');
  });
});
