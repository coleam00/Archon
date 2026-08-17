import { describe, test, expect } from 'bun:test';
import {
  buildRoutingRulesWithProject,
  formatWorkflowContextSection,
  buildOrchestratorSystemAppend,
  buildRunManagementSection,
  formatPausedGateSection,
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

  test('tells the CLI-path providers to pass the user’s own words', () => {
    // Codex/OpenCode/Copilot reach the verbs only through this section — without
    // the clause they get less instruction density than Claude/Pi, which also see
    // the manage_run tool help.
    const section = buildRunManagementSection();

    expect(section).toContain("user's own words");
    expect(section).toContain('never a summary');
    expect(section).toContain('on_reject');
  });

  test('warns that a --json gate decision does not continue the run', () => {
    // The CLI-pointer path is how tool-less providers resolve a gate (#2565).
    // `approve --json` records the decision WITHOUT resuming, so an agent that
    // reflexively adds --json would resolve the gate and strand the run.
    const section = buildRunManagementSection();
    expect(section).toContain('stranded');
    expect(section).toContain('archon workflow resume');
  });
});

describe('formatPausedGateSection', () => {
  const openGate = {
    runId: 'run-abc',
    workflowName: 'prd',
    approval: { type: 'approval', nodeId: 'review', message: 'Approve the plan above.' },
  };

  test('states the gate facts the agent needs to act on', () => {
    const section = formatPausedGateSection(openGate);

    expect(section).toContain('## Paused Approval Gate');
    expect(section).toContain('run-abc');
    expect(section).toContain('prd');
    expect(section).toContain('review');
    expect(section).toContain('Approve the plan above.');
  });

  test('spells out all three outcomes, including resolving nothing', () => {
    const section = formatPausedGateSection(openGate);

    expect(section).toContain('APPROVED');
    expect(section).toContain('REJECTED');
    // The outcome the old auto-approve branch could not produce at all.
    expect(section).toContain('resolve NOTHING');
  });

  test('demonstrates verbatim-ness with a rejection, not only a rule', () => {
    // Stating the rule is weaker than showing it, and the rejection reason is the
    // case where a paraphrase does the most damage — it is what on_reject reworks.
    const section = formatPausedGateSection(openGate);

    expect(section).toContain('why is it editing the schema?');
    expect(section).toContain('NOT "the user objected to the schema change"');
    expect(section).toContain('add error handling for the edge cases');
  });

  test('names no tool, so the section stays usable by every provider', () => {
    // Claude/Pi reach the verbs through `manage_run`; Codex/OpenCode/Copilot reach
    // them through the CLI section. Naming either here advertises the wrong route
    // to half the providers.
    const section = formatPausedGateSection(openGate);

    expect(section).not.toContain('manage_run');
    expect(section).not.toContain('archon workflow');
  });

  test('tells the agent to pass the user’s own words through', () => {
    // A gate with capture_response reads the comment as the node's output, so a
    // paraphrase silently rewrites workflow input.
    expect(formatPausedGateSection(openGate)).toContain('verbatim');
  });

  test('promises continuation so the agent does not hunt for a resume step', () => {
    expect(formatPausedGateSection(openGate)).toContain('no separate resume step');
  });

  test('quotes a multi-line gate message as a single block', () => {
    const section = formatPausedGateSection({
      ...openGate,
      approval: { type: 'approval', nodeId: 'review', message: 'Line one\nLine two' },
    });

    expect(section).toContain('> Line one\n> Line two');
  });

  test('names the loop iteration on an interactive-loop gate', () => {
    const section = formatPausedGateSection({
      ...openGate,
      approval: {
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 3,
        message: 'Review the output',
      },
    });

    expect(section).toContain('Loop iteration: 3');
  });

  test('returns nothing for a gate already resolved and awaiting resume', () => {
    // Resolved gates are waiting on the machine, not on a human — offering them
    // to the agent invites a second decision the operations reject.
    expect(
      formatPausedGateSection({
        ...openGate,
        approval: { ...openGate.approval, resolved: 'approved' },
      })
    ).toBe('');
  });

  test('points at the child run when the pause belongs to a sub-run', () => {
    const section = formatPausedGateSection({
      ...openGate,
      approval: { type: 'child_workflow', nodeId: 'child', message: 'blocked', childRunId: 'kid' },
    });

    expect(section).toContain('kid');
    expect(section).toContain('no gate you can resolve');
  });

  test('does not promise continuation for a container run', () => {
    // executeWorkflow refuses a resume it cannot rewire, so "the run continues"
    // is false here — the agent must send the user to the CLI instead.
    const section = formatPausedGateSection({ ...openGate, containerRun: true });

    expect(section).not.toContain('no separate resume step');
    expect(section).toContain('isolation container');
    expect(section).toContain('archon workflow resume run-abc');
  });

  test('does not tell the agent to resolve the gate when it has no route to the verbs', () => {
    // No project scope means neither manage_run nor the CLI section is present.
    const section = formatPausedGateSection({ ...openGate, agentCanResolve: false });

    expect(section).toContain('## Paused Approval Gate');
    expect(section).toContain('Approve the plan above.');
    expect(section).toContain('no project is attached');
    expect(section).toContain('/workflow approve run-abc');
    // It must not hand out the decision policy for verbs it cannot reach.
    expect(section).not.toContain('resolve the gate as APPROVED');
    expect(section).not.toContain('no separate resume step');
  });

  test('falls back to the explicit commands when the approval context is unusable', () => {
    for (const approval of [undefined, null, {}, { nodeId: 'x' }, 'garbage']) {
      const section = formatPausedGateSection({ ...openGate, approval });
      expect(section).toContain('missing or malformed');
      expect(section).toContain('/workflow approve run-abc');
      expect(section).toContain('/workflow reject run-abc');
    }
  });
});
