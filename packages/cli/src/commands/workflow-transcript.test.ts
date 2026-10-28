import {
  spyOnJsonStdout,
  spyOnStderr,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { WORKTREE_SETUP_EVENT_TYPES } from '@archon/workflows/schemas/worktree-setup';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { workflowLogsCommand } from './workflow-query';

describe('workflowLogsCommand', () => {
  let fixtureRoot: string;
  let archonHome: string;
  let projectRoot: string;
  let transcriptPath: string;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let previousHome: string | undefined;

  const run = (status: 'pending' | 'running' | 'paused' | 'completed' | 'failed') => ({
    origin: { conversationId: 'conv-1' },
    id: '11111111-2222-3333-4444-555555555555',
    workflow_name: 'transcript-test',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status,
    outcome: null,
    user_message: 'test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: projectRoot,
    checkout_baseline: null,
  });

  const stdoutText = (): string =>
    stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('');
  const stderrText = (): string =>
    stderrSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('');

  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'archon-workflow-logs-'));
    archonHome = join(fixtureRoot, 'home');
    projectRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    transcriptPath = join(projectRoot, 'logs', '11111111-2222-3333-4444-555555555555.jsonl');
    mkdirSync(join(projectRoot, 'logs'), { recursive: true });
    previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = archonHome;
    stdoutSpy = spyOnJsonStdout();
    stderrSpy = spyOnStderr();

    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(null);
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockReset();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValue([]);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockReset();
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    await removeTempTree(fixtureRoot);
  });

  it('prints the exact snapshot and resolves a unique project-scoped prefix', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const row = `${JSON.stringify({ type: 'workflow_start', content: 'hello' })}\n`;
    writeFileSync(transcriptPath, row);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      kind: 'repo',
      name: 'acme/widget',
      default_cwd: '/repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: run('completed').id },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('completed'));

    const code = await workflowLogsCommand(createTestWorkflowHost(), '11111111', false, '/repo');

    expect(code).toBe(0);
    expect(stdoutText()).toBe(row);
    expect(stderrText()).toBe('');
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('11111111', 'cb-1');
  });

  it('re-derives a relocated transcript from the run codebase', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const row = `${JSON.stringify({ type: 'workflow_start', content: 'relocated' })}\n`;
    writeFileSync(transcriptPath, row);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...run('completed'),
      output_root: '/previous/archon/home/workspaces/acme/widget',
      checkout_baseline: null,
    });
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      kind: 'repo',
      name: 'acme/widget',
      default_cwd: '/home/u/widget',
    });

    expect(await workflowLogsCommand(createTestWorkflowHost(), run('completed').id, false)).toBe(0);
    expect(stdoutText()).toBe(row);
    expect(stderrText()).toBe('');
  });

  it('preserves UTF-8 characters split across read chunks', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const content = `${'a'.repeat(64 * 1024 - 1)}🙂\n`;
    writeFileSync(transcriptPath, content);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('completed'));

    expect(await workflowLogsCommand(createTestWorkflowHost(), run('completed').id, false)).toBe(0);
    expect(stdoutText()).toBe(content);
  });

  it('guides an active snapshot reader to --follow when the file is absent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('running'));

    expect(await workflowLogsCommand(createTestWorkflowHost(), run('running').id, false)).toBe(1);
    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('Use --follow to wait for it');
  });

  it('fails explicitly for missing and empty terminal transcripts', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('failed'))
      .mockResolvedValueOnce(run('completed'));

    expect(await workflowLogsCommand(createTestWorkflowHost(), run('failed').id, false)).toBe(1);
    writeFileSync(transcriptPath, '');
    expect(await workflowLogsCommand(createTestWorkflowHost(), run('completed').id, false)).toBe(1);

    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('is failed, but its transcript is missing or empty');
    expect(stderrText()).toContain('is completed, but its transcript is missing or empty');
  });

  it('follows paused, running, and completed states and drains after terminal status', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const startRow = `${JSON.stringify({ type: 'workflow_start' })}\n`;
    const terminalRow = `${JSON.stringify({ type: 'workflow_complete' })}\n`;
    writeFileSync(transcriptPath, startRow);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('paused'))
      .mockResolvedValueOnce(run('running'))
      .mockImplementationOnce(() => {
        appendFileSync(transcriptPath, terminalRow);
        return Promise.resolve(run('completed'));
      });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowDb.resumeWorkflowRun as ReturnType<typeof mock>).mockClear();

    const code = await workflowLogsCommand(createTestWorkflowHost(), run('paused').id, true);

    expect(code).toBe(0);
    expect(stdoutText()).toBe(startRow + terminalRow);
    expect(stderrText()).toContain(`Following transcript: ${transcriptPath}`);
    expect(workflowDb.updateWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('renders the complete schema-owned setup event vocabulary', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const messages = WORKTREE_SETUP_EVENT_TYPES.map(type => `Setup evidence for ${type}`);
    writeFileSync(
      transcriptPath,
      WORKTREE_SETUP_EVENT_TYPES.map((type, index) =>
        JSON.stringify({ type, setup: { message: messages[index] } })
      ).join('\n') + '\n'
    );
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('failed'));
    expect(
      await workflowLogsCommand(
        createTestWorkflowHost(),
        run('failed').id,
        false,
        undefined,
        'text'
      )
    ).toBe(0);
    expect(stdoutText()).toBe(messages.join('\n') + '\n');
  });

  it('renders every transcript row kind as text and skips rows it cannot render', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const rows = [
      { type: 'workflow_start', workflow_name: 'fix-issue', content: 'fix #1' },
      {
        type: 'worktree_setup_started',
        setup: { message: 'Worktree setup 1 started: ./setup.sh' },
      },
      {
        type: 'worktree_setup_completed',
        setup: { message: 'Worktree setup 1 completed: ./setup.sh' },
      },
      {
        type: 'worktree_setup_failed',
        setup: { message: 'Worktree setup 2 failed with exit code 7' },
      },
      { type: 'node_start', step: 'plan', content: 'plan-cmd' },
      { type: 'node_start', step: 'lint', content: '<bash>' },
      { type: 'assistant', content: 'Reading the issue.\n\nThen planning.' },
      { type: 'tool', tool_name: 'Bash', tool_input: { command: 'git   status\n--short' } },
      { type: 'tool', tool_name: '/bin/zsh -lc "ls\n-la"', tool_input: {} },
      { type: 'watchdog_reset', step: 'plan', chunk_type: 'assistant', chunk_count: 3 },
      { type: 'step_start', step: 'legacy' },
      { type: 'node_complete', step: 'plan', content: 'plan-cmd', duration_ms: 1234 },
      {
        type: 'exec_output',
        step: 'lint',
        content: '<bash>',
        exit_code: 2,
        stdout_tail: 'ok\n',
        stderr_tail: 'bad\nworse\n',
      },
      { type: 'node_error', step: 'lint', error: 'exit 2' },
      {
        type: 'node_skipped',
        step: 'docs',
        content: 'when_condition',
        cause: { kind: 'condition', expr: "$x == 'y'" },
      },
      { type: 'node_skipped', step: 'old', content: 'when_condition' },
      { type: 'node_suspended', step: 'review-gate', content: 'approval' },
      { type: 'gate_decision', step: 'review-gate', decision: 'approve', content: 'looks good' },
      {
        type: 'gate_decision',
        step: 'review-gate',
        decision: 'reject',
        content: 'two things:\nfix the test',
      },
      { type: 'workflow_resume', workflow_name: 'fix-issue' },
      { type: 'workflow_error', error: 'lint failed' },
      { type: 'workflow_complete' },
    ];
    writeFileSync(
      transcriptPath,
      `${rows.map(row => JSON.stringify(row)).join('\n')}\nnot json\n[1,2]\n`
    );
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('failed'));

    expect(
      await workflowLogsCommand(
        createTestWorkflowHost(),
        run('failed').id,
        false,
        undefined,
        'text'
      )
    ).toBe(0);
    expect(stdoutText()).toBe(
      [
        '[workflow] Started fix-issue',
        'Worktree setup 1 started: ./setup.sh',
        'Worktree setup 1 completed: ./setup.sh',
        'Worktree setup 2 failed with exit code 7',
        '[plan] Started (plan-cmd)',
        '[lint] Started',
        '  Reading the issue.',
        '',
        '  Then planning.',
        '  tool: Bash git status --short',
        '  tool: /bin/zsh -lc "ls -la"',
        '[plan] Completed (1.2s)',
        '[lint] Output (exit 2)',
        '  ok',
        '  stderr:',
        '    bad',
        '    worse',
        '[lint] Failed: exit 2',
        "[docs] Skipped (condition: $x == 'y')",
        '[old] Skipped (when_condition)',
        '[review-gate] Waiting (approval)',
        '[review-gate] Gate: approve (looks good)',
        '[review-gate] Gate: reject',
        '  two things:',
        '  fix the test',
        '[workflow] Resumed fix-issue',
        '[workflow] Failed: lint failed',
        '[workflow] Completed',
        '',
      ].join('\n')
    );
    expect(stderrText()).toBe('');
  });

  it('renders provider events under their node, naming each tool call in its outcome', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    let seq = 0;
    const event = (step: string, attemptId: string, providerEvent: Record<string, unknown>) => ({
      type: 'provider_event',
      workflow_id: 'run-1',
      ts: '2026-10-03T00:00:00.000Z',
      step,
      attemptId,
      seq: seq++,
      observedAt: '2026-10-03T00:00:00.000Z',
      event: providerEvent,
    });
    const rows = [
      { type: 'node_start', step: 'plan', content: '<inline>' },
      { type: 'node_start', step: 'lint', content: '<inline>' },
      event('plan', 'a1', { type: 'agent_thought_chunk', text: 'Check the\nissue first.' }),
      event('plan', 'a1', { type: 'agent_message_chunk', text: 'Reading.\n\nThen planning.' }),
      event('plan', 'a1', {
        type: 'tool_call',
        toolCallId: 'c1',
        name: 'Bash',
        rawInput: { command: 'git status' },
      }),
      event('plan', 'a1', {
        type: 'tool_call',
        toolCallId: 'c2',
        name: 'flag',
        rawInput: false,
      }),
      // The other node reuses the call id; its outcome must not take plan's tool name.
      event('lint', 'a2', {
        type: 'tool_call',
        toolCallId: 'c1',
        name: 'command_execution',
        title: '/bin/zsh -lc "bun run lint"',
        rawInput: { command: '/bin/zsh -lc "bun run lint"' },
      }),
      event('plan', 'a1', {
        type: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        output: 'one\ntwo\nthree\nfour\n',
        exitCode: 0,
      }),
      event('lint', 'a2', {
        type: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
        output: 'error: bad',
        outputTruncated: true,
        exitCode: 1,
      }),
      event('lint', 'a2', { type: 'warning', code: 'codex.x', message: 'model fell back' }),
      event('lint', 'a2', { type: 'mcp_server_status', server: 'gh', status: 'connected' }),
      event('lint', 'a2', {
        type: 'mcp_server_status',
        server: 'db',
        status: 'failed',
        error: 'timeout',
      }),
      event('lint', 'a2', { type: 'compaction', phase: 'started', trigger: 'auto' }),
      event('lint', 'a2', {
        type: 'compaction',
        phase: 'completed',
        tokensBefore: 9000,
        tokensAfter: 2000,
      }),
      event('lint', 'a2', {
        type: 'subtask',
        taskId: 't1',
        status: 'started',
        description: 'scan',
      }),
      event('lint', 'a2', { type: 'subtask', taskId: 't1', status: 'running', summary: 'half' }),
      event('lint', 'a2', { type: 'subtask', taskId: 't1', status: 'completed', summary: 'done' }),
      event('lint', 'a2', {
        type: 'hook',
        hookId: 'h1',
        hookName: 'guard',
        hookEvent: 'PreToolUse',
        status: 'started',
      }),
      event('lint', 'a2', {
        type: 'hook',
        hookId: 'h1',
        hookName: 'guard',
        hookEvent: 'PreToolUse',
        status: 'failed',
        exitCode: 2,
      }),
      event('lint', 'a2', { type: 'state_update', state: 'running' }),
      event('lint', 'a2', { type: 'state_update', state: 'requires_action' }),
      // A newer event type, and a line missing its event: neither renders nor throws.
      event('lint', 'a2', { type: 'plan_update', entries: [] }),
      {
        type: 'provider_event',
        workflow_id: 'run-1',
        ts: '2026-10-03T00:00:00.000Z',
        step: 'lint',
      },
      { type: 'node_complete', step: 'plan', duration_ms: 1000 },
    ];
    writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('completed'));

    expect(
      await workflowLogsCommand(
        createTestWorkflowHost(),
        run('completed').id,
        false,
        undefined,
        'text'
      )
    ).toBe(0);
    expect(stdoutText()).toBe(
      [
        '[plan] Started',
        '[lint] Started',
        '[plan]',
        '  thinking: Check the issue first.',
        '  Reading.',
        '',
        '  Then planning.',
        '  tool: Bash git status',
        '  tool: flag false',
        '[lint]',
        '  tool: /bin/zsh -lc "bun run lint"',
        '[plan]',
        '  completed: Bash (exit 0)',
        '    (1 earlier lines)',
        '    two',
        '    three',
        '    four',
        '[lint]',
        '  failed: /bin/zsh -lc "bun run lint" (exit 1, output truncated)',
        '    error: bad',
        '  warning: model fell back (codex.x)',
        '  mcp db: failed (timeout)',
        '  compaction started (auto)',
        '  compaction completed: 9000 -> 2000 tokens',
        '  subtask started: scan',
        '  subtask completed: done',
        '  hook failed: guard (PreToolUse, exit 2)',
        '  waiting on the user',
        '[plan] Completed (1s)',
        '',
      ].join('\n')
    );
  });

  it('follows as text, rendering a row only once it is whole', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const nodeRow = JSON.stringify({ type: 'node_start', step: 'build' });
    const splitAt = 10;
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'workflow_start', workflow_name: 'wf' })}\n${nodeRow.slice(0, splitAt)}`
    );
    let stdoutAfterFirstDrain = '';
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('running'))
      .mockImplementationOnce(() => {
        stdoutAfterFirstDrain = stdoutText();
        appendFileSync(
          transcriptPath,
          `${nodeRow.slice(splitAt)}\n${JSON.stringify({ type: 'workflow_complete' })}\n`
        );
        return Promise.resolve(run('completed'));
      });

    expect(
      await workflowLogsCommand(
        createTestWorkflowHost(),
        run('running').id,
        true,
        undefined,
        'text'
      )
    ).toBe(0);
    expect(stdoutAfterFirstDrain).toBe('[workflow] Started wf\n');
    expect(stdoutText()).toBe('[workflow] Started wf\n[build] Started\n[workflow] Completed\n');
  });

  it('fails if the transcript shrinks behind the current offset', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'workflow_start' })}\n`);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('running'))
      .mockImplementationOnce(() => {
        truncateSync(transcriptPath, 0);
        return Promise.resolve(run('running'));
      });

    const following = workflowLogsCommand(createTestWorkflowHost(), run('running').id, true);

    expect(await following).toBe(1);
    expect(stderrText()).toContain('Transcript was truncated');
  });
});
