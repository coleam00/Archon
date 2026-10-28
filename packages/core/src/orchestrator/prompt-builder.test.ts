// @archon-test-isolated
import { describe, test, expect, afterEach } from 'bun:test';
import {
  buildRoutingRulesWithProject,
  formatWorkflowContextSection,
  buildOrchestratorSystemAppend,
  buildRunManagementSection,
  formatWorkflowSection,
  formatPausedGateSection,
  type LaunchChannel,
} from './prompt-builder';
import { buildReportWorkflowNoMatchTool } from './chat-tools';
import { join } from 'node:path';
import type { Codebase, Conversation } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

const invoked = (p: string): string[] => [...p.matchAll(/workflow: "([^"]+)"/g)].map(m => m[1]);

describe('buildRoutingRulesWithProject', () => {
  test.each(['tools', 'cli'] as const)('%s gives useful options when no workflow fits', channel => {
    const rules = buildRoutingRulesWithProject(channel);
    expect(rules).toContain('no listed workflow fits');
    expect(rules).toContain(
      channel === 'tools' ? buildReportWorkflowNoMatchTool().name : 'archon telemetry no-match'
    );
    expect(rules).toContain('Do not report no match for ordinary questions');
    expect(rules).toContain('closest available option and its limits');
    expect(rules).toContain('author a workflow for repeatable work');
    expect(rules).toContain('coding agent directly for one-off work');
  });

  test('CLI launches use complete tasks, inputs and headless semantics once scoped', () => {
    const rules = buildRoutingRulesWithProject('cli', 'my-project');
    expect(rules).toContain('archon workflow run <workflow> "<message>" --detach');
    expect(rules).toContain('--input name=value');
    expect(rules).toContain('self-contained task description');
    expect(rules).toContain('Quote every shell argument safely');
    expect(rules).toContain('headless');
    expect(rules).toContain('CLI identity');
    expect(rules).not.toContain('/invoke-workflow');
  });

  test('projectless CLI chats request selection and explicit user registration', () => {
    const rules = buildRoutingRulesWithProject('cli');
    expect(rules).toContain('Before launching or managing runs, ask the user to select');
    expect(rules).toContain('Displaying a command does not execute it');
    expect(rules).toContain('Registration alone does not bind');
    expect(rules).toContain('/register-project --folder');
  });

  test('the tools channel teaches the typed tools and no command line the scan would read', () => {
    for (const rules of [
      buildRoutingRulesWithProject('tools'),
      buildRoutingRulesWithProject('tools', 'p'),
    ]) {
      expect(rules).toContain('invoke_workflow');
      expect(rules).toContain('register_project');
      expect(rules).not.toContain('/invoke-workflow');
      expect(rules).not.toContain('/register-project');
    }
  });

  test.each([
    ['tools', undefined, 'but do NOT call `invoke_workflow`'],
    ['tools', 'p', 'but do NOT call `invoke_workflow`'],
  ] as const)(
    '%s examples (project %s) invoke only the placeholder and answer questions directly',
    (channel, project, noInvoke) => {
      const rules = buildRoutingRulesWithProject(channel, project);
      const routing = rules.split('## Project Setup')[0];
      expect(routing).not.toMatch(/\barchon-[\w-]+\b/);
      const [, action, question] = routing.split(/Example \((?:clear intent|ambiguous[^)]*)\):/);
      expect(invoked(action)).toEqual(['{workflow-name}']);
      expect(invoked(question)).toEqual([]);
      expect(rules).toContain(noInvoke);
    }
  );

  test.each(['tools', 'cli'] as const)(
    '%s rules state prompt must be self-contained with no conversation knowledge',
    channel => {
      expect(buildRoutingRulesWithProject(channel)).toContain(
        'NO knowledge of the conversation history'
      );
    }
  );
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

describe('formatWorkflowSection', () => {
  test('carries deprecation guidance only for deprecated workflows', () => {
    const section = formatWorkflowSection([
      { name: 'current', description: 'Current', nodes: [] },
      { name: 'legacy', description: 'Legacy', nodes: [], deprecated: { message: 'Use current.' } },
    ]);
    expect(section).toContain('**current**\n  Current\n  Type:');
    expect(section).toContain('**legacy**\n  Legacy\n  Deprecated: Use current.\n  Type:');
  });

  test('lists declared inputs so the agent can supply them', () => {
    const section = formatWorkflowSection([
      {
        name: 'release',
        description: 'Release',
        nodes: [],
        inputs: {
          base_branch: { required: true, description: 'Branch to release from' },
          dry_run: { default: false },
          note: {},
        },
      },
    ]);
    expect(section).toContain(
      '  Inputs:\n    - base_branch (required): Branch to release from\n    - dry_run (default: false)\n    - note (optional)\n  Type:'
    );
  });
});

describe('buildOrchestratorSystemAppend', () => {
  const makeConversation = (codebaseId: string | null): Conversation => ({
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
    user_id: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  const codebases: Codebase[] = [
    {
      id: 'cb-1',
      name: 'my-project',
      default_cwd: '/path/to/project',
      ai_assistant_type: 'claude',
      repository_url: null,
      default_branch: 'main',
      kind: 'repo',
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];

  const workflows: WorkflowDefinition[] = [
    {
      name: 'assist',
      description: 'General assistance',
      nodes: [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'command', name: 'archon-assist' },
          depends_on: [],
        },
      ],
    },
  ];

  test('returns orchestrator prompt when no codebase is scoped', async () => {
    const result = await buildOrchestratorSystemAppend(
      makeConversation(null),
      codebases,
      workflows,
      'cli'
    );
    expect(result).toContain('# Archon Orchestrator');
    expect(result).toContain('## Registered Projects');
    expect(result).toContain('my-project');
  });

  test('returns project-scoped prompt when codebase is scoped', async () => {
    const result = await buildOrchestratorSystemAppend(
      makeConversation('cb-1'),
      codebases,
      workflows,
      'cli'
    );
    expect(result).toContain('# Archon Orchestrator');
    expect(result).toContain('## Active Project');
    expect(result).toContain('my-project');
  });

  test('falls back to orchestrator prompt when codebase_id does not match', async () => {
    const result = await buildOrchestratorSystemAppend(
      makeConversation('nonexistent'),
      codebases,
      workflows,
      'cli'
    );
    expect(result).toContain('## Registered Projects');
  });

  test('includes CLI management exactly once only for a resolved scoped project', async () => {
    const scoped = await buildOrchestratorSystemAppend(
      makeConversation('cb-1'),
      codebases,
      workflows,
      'cli'
    );
    const unscoped = await buildOrchestratorSystemAppend(
      makeConversation(null),
      codebases,
      workflows,
      'cli'
    );
    expect(scoped.split('## Managing Workflow Runs')).toHaveLength(2);
    expect(scoped).toContain('--chat-project-id "cb-1"');
    const native = await buildOrchestratorSystemAppend(
      makeConversation('cb-1'),
      codebases,
      workflows,
      'tools'
    );
    const missing = await buildOrchestratorSystemAppend(
      makeConversation('missing'),
      codebases,
      workflows,
      'cli'
    );
    expect(native).not.toContain('## Managing Workflow Runs');
    expect(missing).not.toContain('## Managing Workflow Runs');
    expect(unscoped).not.toContain('## Managing Workflow Runs');
  });
});

describe('workspaces root in the prompt', () => {
  const envKeys = ['ARCHON_HOME', 'ARCHON_DOCKER', 'WORKSPACE_PATH'] as const;
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

  afterEach(() => {
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const codebase: Codebase = {
    id: 'cb-1',
    name: 'my-project',
    default_cwd: '/path/to/project',
    ai_assistant_type: 'claude',
    repository_url: null,
    default_branch: 'main',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
  const conversation = (codebaseId: string | null): Conversation => ({
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-1',
    codebase_id: codebaseId,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'pi',
    title: null,
    hidden: false,
    deleted_at: null,
    user_id: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  });

  const promptsFor = async (channel: LaunchChannel): Promise<string[]> => [
    await buildOrchestratorSystemAppend(conversation(null), [codebase], [], channel),
    await buildOrchestratorSystemAppend(conversation('cb-1'), [codebase], [], channel),
  ];

  test.each([
    {
      install: 'custom ARCHON_HOME',
      env: { ARCHON_HOME: join('/srv', 'archon-data') },
      root: join('/srv', 'archon-data', 'workspaces'),
    },
    { install: 'Docker', env: { ARCHON_DOCKER: 'true' }, root: join('/.archon', 'workspaces') },
    {
      // A Windows home such as C:\Users\Jane Doe puts a space in the root, so the
      // clone destination must stay one shell word.
      install: 'ARCHON_HOME with a space',
      env: { ARCHON_HOME: join('/srv', 'archon data') },
      root: join('/srv', 'archon data', 'workspaces'),
    },
  ])('$install: every prompt names the runtime root', async ({ env, root }) => {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, env);

    const commandPrompts = await promptsFor('cli');
    const toolPrompts = await promptsFor('tools');
    for (const prompt of [...commandPrompts, ...toolPrompts, buildRunManagementSection()]) {
      expect(prompt).toContain(`${root}/`);
      expect(prompt).not.toContain('~/.archon/workspaces');
      expect(prompt).not.toContain('/home/user/.archon');
    }
    for (const prompt of [...commandPrompts, ...toolPrompts]) {
      expect(prompt).toContain(`Your working directory is ${root}/`);
      expect(prompt).toContain('choose an unoccupied source path');
      expect(prompt).toContain('Use the name returned by registration');
      expect(prompt).toContain(
        `git clone https://github.com/{owner}/{repo} "{unoccupied-source-path}"`
      );
    }
    for (const prompt of commandPrompts) {
      expect(prompt).toContain(`/register-project my-new-app ${root}/user/my-new-app/source`);
      expect(prompt).toContain('/register-project {project-name} {path-to-source}');
    }
    for (const prompt of toolPrompts) {
      expect(prompt).toContain(
        `register_project(name: "my-new-app", path: "${root}/user/my-new-app/source")`
      );
    }
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
      'archon workflow cancel',
      'archon workflow abandon',
    ]) {
      expect(section).toContain(verb);
    }
    expect(section).toContain('--json');
    expect(section).toContain('--detach');
    expect(section).toContain('has that process stopped first');
    expect(section).toContain('discard a run whose owner is gone');
  });

  test('scopes CLI operations to registered repo and folder directories', () => {
    const section = buildRunManagementSection();
    expect(section).toContain('registered project directory (repo or folder)');
    expect(section).toContain('not the projectless workspace');
    expect(section).toContain('do not use `--all`');
    expect(section).toContain('/setproject <name>');
    expect(section).not.toContain('install-wide visibility');
  });

  test('tells the CLI-path providers to pass the user’s own words', () => {
    // OpenCode/Copilot reach the verbs only through this section — without
    // the clause they get less instruction density than native-tool providers, which see
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
  /** A paused run carrying `approval`, in the shape formatPausedGateSection reads. */
  const pausedRun = (approval: unknown, metadata: Record<string, unknown> = {}) => ({
    run: {
      id: 'run-abc',
      workflow_name: 'prd',
      status: 'paused' as const,
      metadata: { approval, ...metadata },
    },
  });

  const openGate = pausedRun({
    type: 'approval',
    nodeId: 'review',
    message: 'Approve the plan above.',
  });

  test.each([true, false])(
    'authored guidance uses declared responses (agentCanResolve: %s)',
    agentCanResolve => {
      const gate = pausedRun({
        type: 'approval',
        nodeId: 'review',
        message: 'Choose a direction',
        decisionsAuthored: true,
        decisions: [
          { id: 'accept', label: 'Accept plan' },
          { id: 'revise', label: 'Revise plan' },
        ],
      });
      const section = formatPausedGateSection({ ...gate, agentCanResolve });
      expect(section).toContain('Accept plan');
      expect(section).toContain('Revise plan');
      expect(section).toContain('respond run-abc accept');
      expect(section).toContain('respond run-abc revise');
      expect(section).not.toContain('approve run-abc');
      expect(section).not.toContain('reject run-abc');
      expect(section).not.toContain('APPROVED');
      expect(section).not.toContain('REJECTED');
      if (agentCanResolve) {
        expect(section).toContain('verbatim');
        expect(section).toContain('resolve NOTHING');
      }
    }
  );

  const authoredGate = {
    type: 'approval',
    nodeId: 'review',
    message: 'Choose a direction',
    decisionsAuthored: true,
    decisions: [
      { id: 'accept', label: 'Accept plan' },
      { id: 'revise', label: 'Revise plan' },
    ],
  };

  test('authored container guidance records the decision and directs continuation to the CLI', () => {
    const section = formatPausedGateSection(pausedRun(authoredGate, { isolation: 'container' }));
    expect(section).toContain('respond run-abc accept');
    expect(section).toContain('records the decision but CANNOT continue the run from here');
    expect(section).toContain('`archon workflow resume run-abc`');
    expect(section).not.toContain('no separate resume step');
  });

  test.each([true, false])(
    'authored commands use the surface spelling (agentCanResolve: %s)',
    agentCanResolve => {
      const section = formatPausedGateSection({
        ...pausedRun(authoredGate),
        agentCanResolve,
        surface: { formatWorkflowCommand: command => `/archon-workflow ${command}` },
      });
      expect(section).toContain('`/archon-workflow respond run-abc accept [text]`');
      expect(section).toContain('`/archon-workflow respond run-abc revise [text]`');
      expect(section.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
    }
  );

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
    // Claude/Codex/Pi reach the verbs through `manage_run`; OpenCode/Copilot reach
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
    const section = formatPausedGateSection(
      pausedRun({ type: 'approval', nodeId: 'review', message: 'Line one\nLine two' })
    );

    expect(section).toContain('> Line one\n> Line two');
  });

  test('names the loop iteration on an interactive-loop gate', () => {
    const section = formatPausedGateSection(
      pausedRun({
        type: 'interactive_loop',
        nodeId: 'refine',
        iteration: 3,
        message: 'Review the output',
      })
    );

    expect(section).toContain('Loop iteration: 3');
  });

  test('returns nothing for a gate already resolved and awaiting resume', () => {
    // Resolved gates are waiting on the machine, not on a human — offering them
    // to the agent invites a second decision the operations reject.
    expect(
      formatPausedGateSection(
        pausedRun({
          type: 'approval',
          nodeId: 'review',
          message: 'Approve the plan above.',
          resolved: 'approved',
        })
      )
    ).toBe('');
  });

  test('points at the child run when the pause belongs to a sub-run', () => {
    const section = formatPausedGateSection(
      pausedRun({
        type: 'child_workflow',
        nodeId: 'child',
        message: 'blocked',
        childRunId: 'kid',
      })
    );

    expect(section).toContain('kid');
    expect(section).toContain('no gate you can resolve');
  });

  test('does not promise continuation for a container run', () => {
    // executeWorkflow refuses a resume it cannot rewire, so "the run continues"
    // is false here — the agent must send the user to the CLI instead.
    const section = formatPausedGateSection(
      pausedRun(openGate.run.metadata.approval, { isolation: 'container' })
    );

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

  test('gives the agent the surface spelling of the explicit commands', () => {
    const section = formatPausedGateSection({
      ...openGate,
      agentCanResolve: false,
      surface: { formatWorkflowCommand: command => `/archon-workflow ${command}` },
    });

    expect(section).toContain('`/archon-workflow approve run-abc [comment]`');
    expect(section.replaceAll('/archon-workflow ', '')).not.toContain('/workflow ');
  });

  test('asks for inspection and offers reject when legacy approval context is unusable', () => {
    for (const approval of [undefined, null, {}, { nodeId: 'x' }, 'garbage']) {
      const section = formatPausedGateSection(pausedRun(approval));
      expect(section).toContain('missing or malformed');
      expect(section).toContain('/workflow get run-abc');
      expect(section).toContain('/workflow reject run-abc <reason>');
      expect(section).not.toContain('/workflow approve');
    }
  });

  test('offers only inspection when authored decisions are malformed', () => {
    const section = formatPausedGateSection(
      pausedRun({ nodeId: 'review', message: 'Choose', decisionsAuthored: true })
    );
    expect(section).toContain('missing or malformed');
    expect(section).toContain('/workflow get run-abc');
    expect(section).not.toContain('/workflow approve');
    expect(section).not.toContain('/workflow reject');
  });

  test('does not advertise a gate this build cannot resolve as approvable', () => {
    // A future/corrupt suspend reason reaches the projection as `unreadable`, so the
    // agent is told to inspect the run instead of being told to decide a gate
    // approveWorkflow would refuse.
    const section = formatPausedGateSection(
      pausedRun({ type: 'from_the_future', nodeId: 'review', message: 'Approve the plan above.' })
    );

    expect(section).toContain('missing or malformed');
    expect(section).not.toContain('resolve the gate as APPROVED');
  });

  test('says nothing for a `wait:` pause — the clock owns it, not a person', () => {
    const section = formatPausedGateSection({
      run: {
        id: 'run-abc',
        workflow_name: 'prd',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'hold',
            kind: 'time',
            waitingSince: '2026-08-28T10:00:00.000Z',
            resumeAt: '2026-08-28T11:00:00.000Z',
          },
        },
      },
    });

    expect(section).toBe('');
  });

  test('sends an attention wait from before answers to resume, without approval verbs', () => {
    const section = formatPausedGateSection({
      run: {
        id: 'run-abc',
        workflow_name: 'deliver',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'rerun-ci',
            kind: 'attention',
            waitingSince: '2026-08-28T10:00:00.000Z',
            message: 'Re-run the windows check, then resume.',
          },
        },
      },
    });

    expect(section).toContain('## Paused, needs attention');
    expect(section).toContain('Re-run the windows check, then resume.');
    expect(section).toContain('/workflow resume run-abc');
    expect(section).toContain('Abandon it');
    expect(section).not.toContain('Paused Approval Gate');
    expect(section).not.toContain('/workflow approve');
  });

  test('tells the agent how to answer an attention wait in its form', () => {
    const section = formatPausedGateSection({
      run: {
        id: 'run-abc',
        workflow_name: 'deliver',
        status: 'paused',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'ask',
            kind: 'attention',
            waitingSince: '2026-08-28T10:00:00.000Z',
            message: 'Ship it?',
            pauseId: 'pause-1',
            form: 'approval',
          },
        },
      },
    });

    expect(section).toContain("in the 'approval' form");
    expect(section).toContain('Approve: `/workflow approve run-abc [text]`');
    expect(section).toContain('Reject: `/workflow reject run-abc [text]`');
    expect(section).not.toContain('/workflow resume');
  });
});
