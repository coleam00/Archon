import { describe, test, expect } from 'bun:test';
import {
  buildRoutingRulesWithProject,
  formatWorkflowContextSection,
  buildOrchestratorSystemAppend,
  buildRunManagementSection,
  buildMessageOriginSection,
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

  test('does NOT include the run-management section (orchestrator gates it per-provider)', () => {
    // The CLI run-management pointer is appended by orchestrator-agent.ts only for
    // project-scoped chats on providers WITHOUT the native manage_run tool — never
    // here, so Claude/Pi (nativeTools) don't get a redundant pointer.
    const scoped = buildOrchestratorSystemAppend(makeConversation('cb-1'), codebases, workflows);
    const unscoped = buildOrchestratorSystemAppend(makeConversation(null), codebases, workflows);
    expect(scoped).not.toContain('## Managing Workflow Runs');
    expect(unscoped).not.toContain('## Managing Workflow Runs');
  });
});

describe('buildRunManagementSection', () => {
  test('lists the run-management verbs and the --json hint', () => {
    const section = buildRunManagementSection();
    expect(section).toContain('## Managing Workflow Runs');
    for (const verb of [
      'archon workflow runs',
      'archon workflow get',
      'archon workflow status',
      'archon workflow run',
      'archon workflow approve',
      'archon workflow reject',
      'archon workflow resume',
      'archon workflow abandon',
    ]) {
      expect(section).toContain(verb);
    }
    expect(section).toContain('--json');
    expect(section).toContain('--detach');
  });
});

describe('buildMessageOriginSection', () => {
  test('reports the channel ID and resolved name', () => {
    const section = buildMessageOriginSection(
      { channelId: 'C01ABC234DE', channelName: 'ai-web-project' },
      'slack'
    );

    expect(section).toContain('## Message Origin');
    expect(section).toContain('- Platform: slack');
    expect(section).toContain('- Channel ID: C01ABC234DE');
    expect(section).toContain('- Channel name: ai-web-project');
    expect(section).not.toContain('N/A');
  });

  test('instructs the model to answer from the section instead of guessing', () => {
    const section = buildMessageOriginSection({ channelId: 'C1' }, 'slack');

    expect(section).toContain('do not guess');
  });

  test('renders N/A when name resolution is disabled, keeping the ID', () => {
    const section = buildMessageOriginSection(
      { channelId: 'C01ABC234DE', channelNameStatus: 'disabled' },
      'slack'
    );

    expect(section).toContain('- Channel ID: C01ABC234DE');
    expect(section).toContain('- Channel name: N/A');
    expect(section).toContain('slack.useChannelName');
  });

  test('renders N/A plus a scope hint when resolution failed', () => {
    const section = buildMessageOriginSection(
      { channelId: 'C01ABC234DE', channelNameStatus: 'unavailable' },
      'slack'
    );

    expect(section).toContain('- Channel name: N/A');
    expect(section).toContain('channels:read');
    expect(section).toContain('groups:read');
  });

  test('renders N/A and says direct message for a DM', () => {
    const section = buildMessageOriginSection(
      { channelId: 'D01ABC234DE', channelNameStatus: 'dm' },
      'slack'
    );

    expect(section).toContain('- Channel name: N/A');
    expect(section).toContain('direct message');
  });

  test('falls back to a bare N/A when no status is supplied', () => {
    const section = buildMessageOriginSection({ channelId: 'C1' }, 'slack');

    expect(section).toContain('- Channel name: N/A');
  });

  test('omits the Channel ID line entirely when there is no channel id', () => {
    const section = buildMessageOriginSection({}, 'web');

    expect(section).toContain('- Platform: web');
    expect(section).not.toContain('Channel ID');
    expect(section).toContain('- Channel name: N/A');
  });

  test('carries no per-message data, so it is safe in a cached system append', () => {
    const section = buildMessageOriginSection({ channelId: 'C1', channelName: 'general' }, 'slack');

    // Guards the caching contract: a message ts (e.g. 1712345678.001) here
    // would bust Claude's prompt cache on every single turn.
    expect(section).not.toMatch(/\d{10}\.\d+/);
  });
});
