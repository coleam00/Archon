import {
  mockCanonicalizeProjectPath,
  mockListDashboardRuns,
  statusRuns,
  spyOnJsonStdout,
  firstJsonPayload,
  captureError,
  createTestWorkflowHost,
} from '../test-support/workflow-command-harness';
import { PROVIDER_EVENT_ROW_TYPES } from '@archon/workflows/store';
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_ARTIFACTS_ENGINE_SUBDIR } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import type { WorkflowEventRow } from '@archon/core/schemas/workflow-event';
import { workflowGetCommand, workflowStatusCommand } from './workflow-query';
import { buildNodeSummaries, formatFanOutOutcome } from './workflow-node-summaries';
import type { TerminalRecord } from '@archon/workflows/schemas/terminal-record';
import { fanOutOutcome, type FanOutSlot } from '@archon/workflows/schemas/fan-out-outcome';

const VERBOSE_EVENTS_FIXTURE: WorkflowEventRow[] = [
  {
    id: 'event-without-node',
    workflow_run_id: 'run-verbose-json',
    event_type: 'tool_completed',
    step_name: 'ignored-tool',
    step_index: null,
    data: {},
    created_at: '2026-08-03T10:00:00.000Z',
  },
  {
    id: 'zeta-started',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_started',
    step_name: 'zeta',
    step_index: 0,
    data: {},
    created_at: '2026-08-03T10:00:01.000Z',
  },
  {
    id: 'alpha-started',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_started',
    step_name: 'alpha',
    step_index: 1,
    data: {},
    created_at: '2026-08-03T10:00:02.000Z',
  },
  {
    id: 'middle-skipped',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_skipped_prior_success',
    step_name: 'middle',
    step_index: 2,
    data: {},
    created_at: '2026-08-03T10:00:03.000Z',
  },
  {
    id: 'zeta-completed',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_completed',
    step_name: 'zeta',
    step_index: 0,
    data: { node_output: 'x'.repeat(200) },
    created_at: '2026-08-03T10:00:04.000Z',
  },
  {
    id: 'alpha-failed',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_failed',
    step_name: 'alpha',
    step_index: 1,
    data: {},
    created_at: '2026-08-03T10:00:07.000Z',
  },
  {
    id: 'beta-started',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_started',
    step_name: 'beta',
    step_index: 3,
    data: {},
    created_at: '2026-08-03T10:00:08.000Z',
  },
  {
    id: 'orphan-completed',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_completed',
    step_name: 'orphan',
    step_index: 4,
    data: { node_output: 'y'.repeat(201) },
    created_at: '2026-08-03T10:00:09.000Z',
  },
  {
    id: 'plain-skipped',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_skipped',
    step_name: 'skip-plain',
    step_index: 5,
    data: {},
    created_at: '2026-08-03T10:00:10.000Z',
  },
];

const EXPECTED_VERBOSE_NODES = JSON.parse(
  JSON.stringify(buildNodeSummaries(VERBOSE_EVENTS_FIXTURE))
) as Array<Record<string, unknown>>;

describe('workflowStatusCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockListDashboardRuns.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it.each([false, true])('shows tool attention without verbose mode (json=%s)', async json => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'live',
          workflow_name: 'implement',
          working_path: '/repo',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['implement'],
          metadata: {
            tool_call_attention: [
              {
                streamId: 's',
                nodeId: 'implement',
                provider: 'codex',
                toolCallId: 'tool',
                name: 'bash',
                title: 'bun test',
                startedAt: '2026-10-01T00:00:00.000Z',
                lastProgressAt: '2026-10-01T00:00:00.000Z',
                raisedAt: '2026-10-01T00:30:00.000Z',
                thresholdMs: 1800000,
              },
            ],
          },
        },
      ])
    );
    await workflowStatusCommand(createTestWorkflowHost(), '/repo', { json, all: true });
    if (json)
      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        runs: [{ attention: { kind: 'stalled_tool_calls', status: 'running' } }],
      });
    else {
      const printed = consoleSpy.mock.calls.flat().join(' ');
      expect(printed).toContain('live is still running');
      expect(printed).toContain('bun test');
      expect(printed).not.toContain('resume');
    }
  });

  it.each([false, true])('shows a usage-limit wait with its reset time (json=%s)', async json => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'limited',
          workflow_name: 'implement',
          working_path: '/repo',
          status: 'paused',
          started_at: new Date(),
          active_nodes: [],
          metadata: {
            wait: {
              owner: 'node',
              nodeId: 'implement',
              kind: 'quota',
              pauseId: 'limit-1',
              waitingSince: '2026-10-15T09:00:00.000Z',
              resumeAt: '2026-10-15T14:00:00.000Z',
            },
          },
        },
      ])
    );
    await workflowStatusCommand(createTestWorkflowHost(), '/repo', { json, all: true });
    if (json)
      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        runs: [
          {
            attention: {
              kind: 'usage_limit',
              nodeId: 'implement',
              resumeAt: '2026-10-15T14:00:00.000Z',
            },
          },
        ],
      });
    else
      expect(consoleSpy).toHaveBeenCalledWith(
        "  Wait:   provider usage or rate limit at 'implement' — tries again at 2026-10-15T14:00:00.000Z"
      );
  });

  it('scopes active runs to the cwd-resolved codebase', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-project-a',
      name: 'owner/project-a',
      default_cwd: '/workspace/project-a',
    });
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/project-a', { json: true });

    expect(mockListDashboardRuns).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-project-a' })
    );
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('scopes a Windows-spelled checkout to its canonical registration', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitSpelling = 'C:/workspace/project-a';
    const canonical = 'C:\\workspace\\project-a';
    const findExact = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    findExact.mockClear();
    findExact.mockImplementation(async (path: string) =>
      path === canonical
        ? {
            id: 'cb-project-a',
            name: 'owner/project-a',
            default_cwd: canonical,
          }
        : null
    );
    mockCanonicalizeProjectPath.mockImplementation(async (path: string) =>
      path === gitSpelling ? canonical : path
    );
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));
    try {
      await workflowStatusCommand(createTestWorkflowHost(), gitSpelling, { json: true });
      expect(findExact).toHaveBeenCalledWith(canonical);
      expect(findExact).not.toHaveBeenCalledWith(gitSpelling);
      expect(mockListDashboardRuns).toHaveBeenCalledWith(
        expect.objectContaining({ codebaseId: 'cb-project-a' })
      );
      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({ scopeFallback: false });
    } finally {
      findExact.mockReset().mockResolvedValue(null);
      mockCanonicalizeProjectPath.mockReset().mockImplementation(async (path: string) => path);
    }
  });

  it('scopes a linked worktree to its registered primary checkout', async () => {
    const git = await import('@archon/git');
    const codebaseDb = await import('@archon/core/db/codebases');
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce(
      '/workspace/project-a'
    );
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'cb-project-a',
        name: 'owner/project-a',
        default_cwd: '/workspace/project-a',
        kind: 'repo',
      });
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/project-a-worktree', {
      json: true,
    });

    expect(git.getCanonicalRepoPath).toHaveBeenCalledWith('/workspace/project-a-worktree');
    expect(codebaseDb.findCodebaseByDefaultCwd).toHaveBeenCalledWith('/workspace/project-a');
    expect(mockListDashboardRuns).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-project-a' })
    );
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('uses install-wide active runs for --all without resolving the cwd', async () => {
    const git = await import('@archon/git');
    const codebaseDb = await import('@archon/core/db/codebases');
    const findSpy = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    findSpy.mockClear();
    canonicalSpy.mockClear();
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/project-a', {
      all: true,
      json: true,
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(mockListDashboardRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('flags an unregistered cwd when JSON falls back to install-wide active runs', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/unregistered', {
      json: true,
    });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(true);
  });

  it('announces an unregistered-cwd fallback in human output', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/unregistered');

    expect(consoleSpy).toHaveBeenCalledWith('(not a registered project — showing all runs)');
    expect(consoleSpy).toHaveBeenCalledWith('No active workflows.');
  });

  it('fails instead of returning install-wide runs when project lookup fails', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('lookup unavailable')
    );

    const error = await captureError(
      workflowStatusCommand(createTestWorkflowHost(), '/workspace/project-a', { json: true })
    );

    expect(error.message).toBe('Failed to resolve workflow status project: lookup unavailable');
    expect(mockListDashboardRuns).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('leaves provider events out of verbose node summaries, which never read them', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-summary',
          workflow_name: 'implement',
          working_path: '/workspace/project-a',
          status: 'running',
          started_at: new Date(),
          active_nodes: [],
        },
      ])
    );
    const eventsSpy = workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>;
    eventsSpy.mockClear();
    eventsSpy.mockResolvedValueOnce([]);

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/project-a', {
      json: true,
      verbose: true,
    });

    expect(eventsSpy).toHaveBeenCalledWith('run-summary', {
      excludeEventTypes: PROVIDER_EVENT_ROW_TYPES,
    });
  });

  it('fetches verbose raw events only for runs selected by the project scope', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-project-a',
      name: 'owner/project-a',
      default_cwd: '/workspace/project-a',
    });
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-project-a',
          workflow_name: 'implement',
          working_path: '/workspace/project-a-worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: [],
        },
      ])
    );
    const eventsSpy = workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>;
    eventsSpy.mockClear();
    eventsSpy.mockResolvedValueOnce([]);

    await workflowStatusCommand(createTestWorkflowHost(), '/workspace/project-a', {
      json: true,
      verbose: true,
      rawEvents: true,
    });

    expect(mockListDashboardRuns).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-project-a' })
    );
    expect(eventsSpy).toHaveBeenCalledTimes(1);
    expect(eventsSpy).toHaveBeenCalledWith('run-project-a');
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      scopeFallback: boolean;
      runs: Array<{ id: string; events: unknown[] }>;
    };
    expect(parsed.scopeFallback).toBe(false);
    expect(parsed.runs).toEqual([expect.objectContaining({ id: 'run-project-a', events: [] })]);
  });

  it('does not expose stored child-block command prose in human status', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'parent',
          workflow_name: 'parent-flow',
          working_path: '/test/path',
          status: 'paused',
          started_at: new Date(),
          active_nodes: [],
          metadata: {
            approval: {
              nodeId: 'sub',
              type: 'child_workflow',
              childRunId: 'child-full-id',
              message: '/workflow approve child-full-id',
            },
          },
        },
      ])
    );
    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', { all: true });
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain('parent-flow');
    expect(printed).not.toContain('/workflow ');
  });

  it('should print message when no active runs', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', { all: true });

    expect(consoleSpy).toHaveBeenCalledWith('No active workflows.');
  });

  it('prints the complete active run layout with fixed age and active nodes', async () => {
    const now = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
    try {
      mockListDashboardRuns.mockResolvedValueOnce(
        statusRuns([
          {
            id: 'run-abc',
            workflow_name: 'implement',
            working_path: '/path/to/worktree',
            status: 'running',
            started_at: new Date('2026-10-23T11:55:00Z'),
            active_nodes: ['parallel-a', 'parallel-b'],
          },
        ])
      );

      await workflowStatusCommand(createTestWorkflowHost(), '/test/path', { all: true });

      expect(consoleSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n') + '\n').toBe(
        '\nActive workflows (1):\n\n' +
          '  ID:     run-abc\n' +
          '  Name:   implement\n' +
          '  Path:   /path/to/worktree\n' +
          '  Status: running\n' +
          '  Age:    5m\n' +
          '  Active nodes: parallel-a, parallel-b\n\n'
      );
    } finally {
      now.mockRestore();
    }
  });

  it('should label authored outcome separately from active execution status', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-paused',
          workflow_name: 'review',
          working_path: '/path/to/worktree',
          status: 'paused',
          outcome: 'succeeded',
          started_at: new Date(),
          active_nodes: ['parallel-a', 'parallel-b'],
        },
      ])
    );

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', { all: true });

    expect(consoleSpy).toHaveBeenCalledWith('  Status: paused');
    expect(consoleSpy).toHaveBeenCalledWith('  Authored outcome: succeeded');
  });

  it('should output JSON when json=true', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', { json: true, all: true });

    expect(stdoutSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ runs: [], scopeFallback: false }, null, 2)}\n`,
      expect.any(Function)
    );
  });

  it('keeps parallel active nodes in non-verbose JSON', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-parallel',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['parallel-a', 'parallel-b'],
        },
      ])
    );

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', { json: true, all: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ active_nodes: string[] }>;
    };
    expect(parsed.runs[0]?.active_nodes).toEqual(['parallel-a', 'parallel-b']);
  });

  it('should show node summaries in verbose mode', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-verbose',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 30 * 1000),
          active_nodes: ['plan'],
        },
      ])
    );

    const startTime = new Date(Date.now() - 25 * 1000).toISOString();
    const endTime = new Date(Date.now() - 15 * 1000).toISOString();
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e1',
        workflow_run_id: 'run-verbose',
        event_type: 'node_started',
        step_name: 'plan',
        step_index: null,
        data: {},
        created_at: startTime,
      },
      {
        id: 'e2',
        workflow_run_id: 'run-verbose',
        event_type: 'node_completed',
        step_name: 'plan',
        step_index: null,
        data: { node_output: 'Plan output here' },
        created_at: endTime,
      },
    ]);

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
      verbose: true,
      all: true,
    });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('Nodes:'))).toBe(true);
    expect(calls.some(c => c.includes('✓') && c.includes('plan'))).toBe(true);
    expect(calls.some(c => c.includes('Plan output here'))).toBe(true);
  });

  it('should show error message for failed node in verbose mode', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-failed',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 30 * 1000),
          active_nodes: ['implement'],
        },
      ])
    );

    const startTime = new Date(Date.now() - 20 * 1000).toISOString();
    const endTime = new Date(Date.now() - 10 * 1000).toISOString();
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e3',
        workflow_run_id: 'run-failed',
        event_type: 'node_started',
        step_name: 'implement',
        step_index: null,
        data: {},
        created_at: startTime,
      },
      {
        id: 'e4',
        workflow_run_id: 'run-failed',
        event_type: 'node_failed',
        step_name: 'implement',
        step_index: null,
        data: { error: 'Compilation failed' },
        created_at: endTime,
      },
    ]);

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
      verbose: true,
      all: true,
    });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('✗') && c.includes('implement'))).toBe(true);
    expect(calls.some(c => c.includes('Compilation failed'))).toBe(true);
  });

  it('shows failed and unstarted fan-out children in verbose status', async () => {
    const eventsDb = await import('@archon/core/db/workflow-events');
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-fan',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'failed',
          started_at: new Date('2026-10-22T10:00:00.000Z'),
          active_nodes: [],
        },
      ])
    );
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'work-failed',
        workflow_run_id: 'run-fan',
        event_type: 'node_failed',
        step_name: 'work',
        step_index: null,
        data: {
          error: 'children failed',
          fan_out: true,
          fan_out_outcome: fanOutOutcome([
            { index: 0, outcome: 'failed', child_run_id: 'child-failed', error: 'exit 1' },
            { index: 1, outcome: 'not_started', error: 'refused' },
          ]),
        },
        created_at: '2026-10-22T10:00:01.000Z',
      },
    ]);

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
      verbose: true,
      all: true,
    });

    const lines = consoleSpy.mock.calls.map((call: unknown[]) => call[0]);
    expect(lines).toContain(
      '        Fan-out work: 2 of 2 children did not complete (1 failed, 1 not started)'
    );
    expect(lines).toContain('          item 0: failed — run child-failed — exit 1');
    expect(lines).toContain('          item 1: not started — refused');
  });

  it('should not show nodes section when no events in verbose mode', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-empty',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 5 * 1000),
          active_nodes: [],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
      verbose: true,
      all: true,
    });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('Nodes:'))).toBe(false);
  });

  it('emits the shared ordered node summaries in verbose JSON by default', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-verbose-json',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['beta'],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
      json: true,
      verbose: true,
      all: true,
    });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ nodes: Array<Record<string, unknown>>; events?: unknown[] }>;
    };
    expect(parsed.runs[0]?.nodes).toEqual(EXPECTED_VERBOSE_NODES);
    expect(parsed.runs[0]?.events).toBeUndefined();
    expect(parsed.runs[0]?.nodes.map(node => node.nodeId)).toEqual([
      'zeta',
      'alpha',
      'middle',
      'beta',
      'orphan',
      'skip-plain',
    ]);

    const [zeta, alpha, middle, beta, orphan] = parsed.runs[0]?.nodes ?? [];
    expect(zeta).toMatchObject({
      state: 'completed',
      startedAt: '2026-08-03T10:00:01.000Z',
      durationMs: 3_000,
      outputPreview: 'x'.repeat(200),
    });
    expect(alpha).toMatchObject({
      state: 'failed',
      startedAt: '2026-08-03T10:00:02.000Z',
      durationMs: 5_000,
      error: 'Unknown error',
    });
    // A prior-success replay reports the success it describes, with no start
    // time to derive a duration from (#2973).
    expect(middle?.state).toBe('completed');
    expect(middle?.startedAt).toBeUndefined();
    expect(middle?.durationMs).toBeUndefined();
    expect(beta).toMatchObject({
      state: 'running',
      startedAt: '2026-08-03T10:00:08.000Z',
    });
    expect(beta?.durationMs).toBeUndefined();
    expect(orphan?.startedAt).toBeUndefined();
    expect(orphan?.durationMs).toBeUndefined();
    expect(orphan?.outputPreview).toBe(`${'y'.repeat(200)}...`);
    expect(String(orphan?.outputPreview)).not.toContain('…');
  });

  it('emits raw events in verbose JSON when events=true', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-verbose-json',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['beta'],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
      json: true,
      verbose: true,
      rawEvents: true,
      all: true,
    });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ events: WorkflowEventRow[]; nodes?: unknown[] }>;
    };
    expect(parsed.runs[0]?.events).toEqual(VERBOSE_EVENTS_FIXTURE);
    expect(parsed.runs[0]?.nodes).toBeUndefined();
  });

  it.each([false, true])(
    'fails verbose JSON when a later run event query fails (rawEvents=%s)',
    async rawEvents => {
      const workflowEventsDb = await import('@archon/core/db/workflow-events');
      mockListDashboardRuns.mockResolvedValueOnce(
        statusRuns([
          {
            id: 'run-available',
            workflow_name: 'implement',
            working_path: '/path/to/first-worktree',
            status: 'running',
            started_at: new Date(),
            active_nodes: ['alpha'],
          },
          {
            id: 'run-unavailable',
            workflow_name: 'implement',
            working_path: '/path/to/worktree',
            status: 'running',
            started_at: new Date(),
            active_nodes: ['beta'],
          },
        ])
      );
      (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>)
        .mockResolvedValueOnce(VERBOSE_EVENTS_FIXTURE)
        .mockRejectedValueOnce(new Error('events unavailable'));

      await expect(
        workflowStatusCommand(createTestWorkflowHost(), '/test/path', {
          json: true,
          verbose: true,
          rawEvents,
          all: true,
        })
      ).rejects.toThrow('Failed to fetch workflow events');
      expect(stdoutSpy).not.toHaveBeenCalled();
    }
  );
});

describe('workflowGetCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it.each([0, 20, 21])(
    'summarizes terminal artifact inventory with %s operator files without changing JSON',
    async fileCount => {
      const workflowDb = await import('@archon/core/db/workflows');
      const workflowEventsDb = await import('@archon/core/db/workflow-events');
      const operatorPaths = [
        `reports/${RUN_ARTIFACTS_ENGINE_SUBDIR}/report.md`,
        '.summary.md',
        ...Array.from({ length: 19 }, (_, index) => `report-${index}.md`),
      ].slice(0, fileCount);
      const internalPaths = [
        `${RUN_ARTIFACTS_ENGINE_SUBDIR}/typed-artifacts/internal.json`,
        `${RUN_ARTIFACTS_ENGINE_SUBDIR}/node-output-spills/output.txt`,
      ];
      const record: TerminalRecord = {
        run_id: 'run-terminal-artifacts',
        status: 'completed',
        outcome: null,
        error: null,
        first_failed_node: null,
        nodes: [],
        returns: { availability: 'unavailable', node_id: null, reason: 'not_declared' },
        artifacts: {
          root: null,
          files: [internalPaths[0], ...operatorPaths, internalPaths[1]].map(path => ({
            path,
            size: 42,
          })),
          limitations: [{ kind: 'unreadable', path: 'missing-report.md', code: 'EACCES' }],
        },
      };
      const run = {
        id: record.run_id,
        workflow_name: 'implement',
        status: record.status,
        started_at: new Date(),
        metadata: {},
        output_root: null,
        checkout_baseline: null,
        codebase_id: null,
      };
      const events: WorkflowEventRow[] = [
        {
          id: 'terminal-event',
          workflow_run_id: record.run_id,
          event_type: 'workflow_completed',
          step_name: null,
          step_index: null,
          created_at: '2026-10-23T00:00:00.000Z',
          data: { terminal_record: record },
        },
      ];
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
        .mockResolvedValueOnce(run)
        .mockResolvedValueOnce(run);
      (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>)
        .mockResolvedValueOnce(events)
        .mockResolvedValueOnce(events);

      expect(await workflowGetCommand(createTestWorkflowHost(), record.run_id)).toBe(0);

      const lines: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(lines).toContain(`    Artifacts observed: ${fileCount + internalPaths.length}`);
      expect(lines).toContain('    Engine-internal artifact files (not listed): 2');
      expect(lines.filter(line => line.startsWith('      - '))).toEqual(
        operatorPaths.slice(0, 20).map(path => `      - ${path}`)
      );
      for (const path of internalPaths) expect(lines.join('\n')).not.toContain(path);
      expect(lines.includes('    Artifact list truncated at the display cap')).toBe(fileCount > 20);
      expect(lines).toContain('    Inventory limitation: unreadable EACCES (missing-report.md)');

      expect(await workflowGetCommand(createTestWorkflowHost(), record.run_id, true)).toBe(0);
      expect(JSON.parse(firstJsonPayload(stdoutSpy)).terminal_record).toEqual(record);
    }
  );

  const usageCases: [string, Record<string, unknown>, string, string, string][] = [
    [
      'recorded numbers',
      { total_cost_usd: 0.024, total_tokens_in: 8420, total_tokens_out: 2180 },
      '$0.024',
      '8420',
      '2180',
    ],
    [
      'reported zero',
      { total_cost_usd: 0, total_tokens_in: 0, total_tokens_out: 0 },
      '$0',
      '0',
      '0',
    ],
    [
      'tiny cost',
      { total_cost_usd: 0.00000001, total_tokens_in: 2, total_tokens_out: 3 },
      '$0.00000001',
      '2',
      '3',
    ],
    [
      'summed cost',
      { total_cost_usd: 0.1 + 0.2, total_tokens_in: 2, total_tokens_out: 3 },
      '$0.3',
      '2',
      '3',
    ],
    [
      'large cost',
      { total_cost_usd: 1e21, total_tokens_in: 2, total_tokens_out: 3 },
      '$1000000000000000000000',
      '2',
      '3',
    ],
    ['missing data', {}, 'unknown', 'unknown', 'unknown'],
    [
      'null values',
      { total_cost_usd: null, total_tokens_in: null, total_tokens_out: null },
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'invalid values',
      { total_cost_usd: '0', total_tokens_in: {}, total_tokens_out: '12' },
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'nonfinite values',
      { total_cost_usd: Infinity, total_tokens_in: NaN, total_tokens_out: -Infinity },
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'unknown tokens',
      { total_cost_usd: 1, total_tokens_in: 2, total_tokens_out: 3, total_tokens_unknown: true },
      '$1',
      'unknown',
      'unknown',
    ],
    [
      'malformed token marker',
      { total_tokens_in: 2, total_tokens_out: 3, total_tokens_unknown: 'false' },
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'null token marker',
      { total_tokens_in: 2, total_tokens_out: 3, total_tokens_unknown: null },
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'valid output axis',
      { total_tokens_in: 'bad', total_tokens_out: 3, total_tokens_unknown: false },
      'unknown',
      'unknown',
      '3',
    ],
    ['valid input axis', { total_tokens_in: 2, total_tokens_out: [] }, 'unknown', '2', 'unknown'],
    [
      'negative cost, fractional input and negative output',
      { total_cost_usd: -1, total_tokens_in: 1.5, total_tokens_out: -2 },
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'negative input and fractional output',
      { total_cost_usd: 0.5, total_tokens_in: -2, total_tokens_out: 1.5 },
      '$0.5',
      'unknown',
      'unknown',
    ],
  ];

  it.each(usageCases)(
    'prints qualified usage for %s',
    async (_name, metadata, cost, input, output) => {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-usage',
        checkout_baseline: null,
        workflow_name: 'plan',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata,
      });
      expect(await workflowGetCommand(createTestWorkflowHost(), 'run-usage')).toBe(0);
      expect(consoleSpy).toHaveBeenCalledWith('  Usage (recorded totals; completeness unknown):');
      expect(consoleSpy).toHaveBeenCalledWith(`    Cost: ${cost}`);
      expect(consoleSpy).toHaveBeenCalledWith(`    Input tokens: ${input}`);
      expect(consoleSpy).toHaveBeenCalledWith(`    Output tokens: ${output}`);
    }
  );

  it('prints not-found (human) and exits non-zero for a missing run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand(createTestWorkflowHost(), 'nope');

    expect(consoleSpy).toHaveBeenCalledWith('Workflow run not found: nope');
    // Exit 1 so `get <id> && ...` and CI checks react to a missing run.
    expect(code).toBe(1);
  });

  it('emits {ok:false, error:not_found} JSON and exits non-zero for a missing run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand(createTestWorkflowHost(), 'nope', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: false,
      runId: 'nope',
      error: 'not_found',
    });
    expect(code).toBe(1);
  });

  // #2213 — the read path for a run whose warnings were recorded but never
  // delivered to a conversation (CLI/REST runs, or a failed chat send).
  it('surfaces recorded parse warnings in verbose output', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-pw',
      checkout_baseline: null,
      workflow_name: 'gated',
      working_path: '/repo',
      status: 'completed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e1',
        workflow_run_id: 'run-pw',
        event_type: 'workflow_parse_warnings',
        step_name: null,
        step_index: null,
        data: { workflowName: 'gated', warnings: ["Node 'plan': unknown key 'interactive'"] },
        created_at: new Date().toISOString(),
      },
    ]);

    const code = await workflowGetCommand(createTestWorkflowHost(), 'run-pw', false, true);

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('Ignored keys (1)'))).toBe(true);
    expect(calls.some(c => c.includes("unknown key 'interactive'"))).toBe(true);
    expect(code).toBe(0);
  });

  it('carries recorded parse warnings on the verbose --json payload', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-pw',
      checkout_baseline: null,
      workflow_name: 'gated',
      working_path: '/repo',
      status: 'completed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e1',
        workflow_run_id: 'run-pw',
        event_type: 'workflow_parse_warnings',
        step_name: null,
        step_index: null,
        data: { workflowName: 'gated', warnings: ["Node 'plan': unknown key 'interactive'"] },
        created_at: new Date().toISOString(),
      },
    ]);

    await workflowGetCommand(createTestWorkflowHost(), 'run-pw', true, true);

    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as { parseWarnings?: string[] };
    expect(payload.parseWarnings).toEqual(["Node 'plan': unknown key 'interactive'"]);
  });

  it('renders a persisted skip cause in workflow get', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-skip-cause',
      checkout_baseline: null,
      workflow_name: 'deliver',
      working_path: '/repo',
      status: 'failed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'skip-event',
        workflow_run_id: 'run-skip-cause',
        event_type: 'node_skipped',
        step_name: 'publish',
        step_index: 1,
        data: {
          reason: 'trigger_rule',
          cause: { kind: 'upstream_failed', origin: 'validate' },
        },
        created_at: new Date().toISOString(),
      },
    ]);

    await workflowGetCommand(createTestWorkflowHost(), 'run-skip-cause', false, true);

    expect(consoleSpy).toHaveBeenCalledWith('    - publish (upstream failed: validate)');
  });

  // #3488 acceptance: the stored failure is command-free, so the CLI writes the abandon
  // command in the spelling its own operator can type.
  it('renders the abandon command for a fan-out node blocked on a live child', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-fanout-blocked',
      checkout_baseline: null,
      workflow_name: 'deliver',
      working_path: '/repo',
      status: 'failed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'fanout-failed',
        workflow_run_id: 'run-fanout-blocked',
        event_type: 'node_failed',
        step_name: 'work',
        step_index: 1,
        data: {
          error: "fan_out node 'work': child 0 (run c9d8e7f6) may still be running.",
          blocked_on_child_run_id: 'c9d8e7f6-1111-2222-3333-444455556666',
        },
        created_at: new Date().toISOString(),
      },
    ]);

    await workflowGetCommand(createTestWorkflowHost(), 'run-fanout-blocked', false, true);

    const printed: string = consoleSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
    expect(printed).toContain(
      'Abandon: archon workflow abandon c9d8e7f6-1111-2222-3333-444455556666'
    );
    expect(printed).not.toContain('/workflow ');
  });

  it('renders a persisted timeout skip cause in workflow get', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-timeout-skip',
      checkout_baseline: null,
      workflow_name: 'deliver',
      working_path: '/repo',
      status: 'completed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'timeout-skip-event',
        workflow_run_id: 'run-timeout-skip',
        event_type: 'node_skipped',
        step_name: 'ci-note',
        step_index: 1,
        data: { reason: 'timeout', cause: { kind: 'timeout' } },
        created_at: new Date().toISOString(),
      },
    ]);

    await workflowGetCommand(createTestWorkflowHost(), 'run-timeout-skip', false, true);

    expect(consoleSpy).toHaveBeenCalledWith('    - ci-note (timeout)');
  });

  it('emits {ok:false} JSON (never throws) when the DB lookup fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('connection refused')
    );

    await workflowGetCommand(createTestWorkflowHost(), 'run-x', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      runId: string;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.runId).toBe('run-x');
    expect(parsed.error).toContain('connection refused');
  });

  it('prints run detail (human) including the error from metadata', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-xyz',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: { error: 'Step failed: build' },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-xyz');

    expect(consoleSpy).toHaveBeenCalledWith('  ID:     run-xyz');
    expect(consoleSpy).toHaveBeenCalledWith('  Name:   implement');
    expect(consoleSpy).toHaveBeenCalledWith('  Status: failed');
    expect(consoleSpy).toHaveBeenCalledWith('  Error:  Step failed: build');
    expect(consoleSpy).toHaveBeenCalledWith('  Start:  (not recorded)');
  });

  it('names the interrupt and its signal above the error line', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-interrupted',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        error: 'Process terminated (SIGINT)',
        stop_reason: { reason: 'process_terminated', signal: 'SIGINT' },
      },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-interrupted');

    expect(consoleSpy).toHaveBeenCalledWith('  Stopped: interrupted by the operator (SIGINT)');
    // The error stays: it is the run's persisted failure record, and every other surface
    // shows it. The new line says what the error text cannot claim on its own.
    expect(consoleSpy).toHaveBeenCalledWith('  Error:  Process terminated (SIGINT)');
  });

  it('does not attribute a SIGTERM to the operator', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-signalled',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        error: 'Process terminated (SIGTERM)',
        stop_reason: { reason: 'process_terminated', signal: 'SIGTERM' },
      },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-signalled');

    expect(consoleSpy).toHaveBeenCalledWith('  Stopped: interrupted by a signal (SIGTERM)');
  });

  it('prints no Stopped line for a run that genuinely failed', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-broken',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: { error: 'Bash node failed', stop_reason: { reason: 'node_error' } },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-broken');

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Stopped:'));
    expect(consoleSpy).toHaveBeenCalledWith('  Error:  Bash node failed');
  });

  it('prints no Stopped line once an interrupted run is no longer failed', async () => {
    // Abandoning a failed run cancels it without clearing metadata, so the key outlives
    // the stop it described.
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-abandoned',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'cancelled',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        error: 'Process terminated (SIGINT)',
        stop_reason: { reason: 'process_terminated', signal: 'SIGINT' },
      },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-abandoned');

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Stopped:'));
  });

  it('carries the stop reason through --json', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-interrupted-json',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        error: 'Process terminated (SIGINT)',
        stop_reason: { reason: 'process_terminated', signal: 'SIGINT' },
      },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-interrupted-json', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      status: string;
      metadata: { stop_reason?: unknown };
    };
    expect(parsed.status).toBe('failed');
    expect(parsed.metadata.stop_reason).toEqual({
      reason: 'process_terminated',
      signal: 'SIGINT',
    });
  });

  it('prints the checkout the run started from', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-start',
      checkout_baseline: {
        kind: 'git',
        sampledAt: '2026-09-23T10:00:00.000Z',
        commit: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        worktree: {
          status: 'dirty',
          content: 'complete',
          staged: 1,
          unstaged: 2,
          untracked: 3,
          manifest: {
            pointer: {
              type: 'archon_artifact',
              run_id: 'run-start',
              path: '.archon/checkout/x.json',
            },
            sha256: 'c'.repeat(64),
            entries: 6,
          },
        },
        cutFromCommit: 'd'.repeat(40),
      },
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-start');

    expect(consoleSpy).toHaveBeenCalledWith(
      `  Start:  ${'a'.repeat(40)} (dirty: 1 staged, 2 unstaged, 3 untracked, branch cut from ${'d'.repeat(40)})`
    );
  });

  it('prints contradictory status and authored outcome as separate fields', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-contradictory',
      checkout_baseline: null,
      workflow_name: 'review',
      status: 'completed',
      outcome: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-contradictory');

    expect(consoleSpy).toHaveBeenCalledWith('  Status: completed');
    expect(consoleSpy).toHaveBeenCalledWith('  Authored outcome: failed');
  });

  it('emits the raw run as a single clean JSON object', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const metadata = {
      total_cost_usd: 0.024,
      total_tokens_in: null,
      total_tokens_out: 'historical',
      total_tokens_unknown: null,
      custom: { value: 1 },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-json',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata,
    });

    const code = await workflowGetCommand(createTestWorkflowHost(), 'run-json', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      id: string;
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(parsed.id).toBe('run-json');
    expect(parsed.status).toBe('completed');
    expect(parsed.metadata).toEqual(metadata);
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('exposes the transcript path from a trusted persisted output root', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-transcript-home');
    process.env.ARCHON_HOME = archonHome;
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-transcript',
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: outputRoot,
        checkout_baseline: null,
        codebase_id: 'cb-1',
      });

      await workflowGetCommand(createTestWorkflowHost(), 'run-transcript', true);

      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        transcript_path: join(outputRoot, 'logs', 'run-transcript.jsonl'),
      });
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  it('re-derives an out-of-tree historical path through the run codebase', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-relocated-home');
    process.env.ARCHON_HOME = archonHome;
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      const codebaseDb = await import('@archon/core/db/codebases');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-relocated',
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: '/old-machine/.archon/workspaces/old/name',
        checkout_baseline: null,
        codebase_id: 'cb-relocated',
      });
      // Both readers in workflow get consult the codebase row; the resolver
      // re-derives identically on each call against the same id.
      (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValue({
        id: 'cb-relocated',
        kind: 'repo',
        name: 'new/widget',
        default_cwd: '/repos/widget',
      });

      await workflowGetCommand(createTestWorkflowHost(), 'run-relocated', true);

      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        transcript_path: join(
          archonHome,
          'workspaces',
          'new',
          'widget',
          'logs',
          'run-relocated.jsonl'
        ),
      });
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  it('reports an unavailable transcript without failing an otherwise readable legacy run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-legacy',
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
      output_root: null,
      checkout_baseline: null,
      codebase_id: null,
    });

    const code = await workflowGetCommand(createTestWorkflowHost(), 'run-legacy', true);

    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      transcript_path: null,
      terminal_record: null,
    });
    expect(code).toBe(0);
  });

  // #3097 — every persisted-root reader in `workflow get` must go through the
  // shared resolver's containment check. The leave-behind artifact list was the
  // last path that still walked `run.output_root` directly. These tests pin
  // both halves of the fix: the resolver is consulted, and the same refusal
  // surface the transcript reader already exposes applies.
  it('refuses to walk an out-of-tree persisted output_root even when the dir exists (#3097)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-refused-home');
    const decoyRoot = mkdtempSync(join(tmpdir(), 'archon-get-artifact-decoy-'));
    const decoyArtifactsDir = join(decoyRoot, 'artifacts', 'runs', 'run-artifact-refused');
    mkdirSync(decoyArtifactsDir, { recursive: true });
    writeFileSync(join(decoyArtifactsDir, 'should-not-be-listed.txt'), 'poison');
    process.env.ARCHON_HOME = archonHome;
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-artifact-refused',
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: decoyRoot,
        checkout_baseline: null,
        codebase_id: null,
      });

      await workflowGetCommand(createTestWorkflowHost(), 'run-artifact-refused', true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: { artifactFiles?: string[] };
      };
      expect(parsed.leave_behind).toBeDefined();
      expect(parsed.leave_behind?.artifactFiles).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
      await removeTempTree(decoyRoot);
    }
  });

  it('re-derives a relocated leave-behind artifact dir through the run codebase (#3097)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-relocated-home');
    process.env.ARCHON_HOME = archonHome;
    const runId = 'run-artifact-relocated';
    const rederivedArtifactsDir = join(
      archonHome,
      'workspaces',
      'new',
      'widget',
      'artifacts',
      'runs',
      runId
    );
    mkdirSync(rederivedArtifactsDir, { recursive: true });
    writeFileSync(join(rederivedArtifactsDir, 'marker.txt'), 'ok');
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      const codebaseDb = await import('@archon/core/db/codebases');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        // Out-of-tree persisted root — the resolver must re-derive under the
        // current ARCHON_HOME via the run's codebase row, not walk the original
        // path.
        output_root: '/old-machine/.archon/workspaces/old/name',
        checkout_baseline: null,
        codebase_id: 'cb-relocated-artifact',
      });
      // Both readers in workflow get consult the codebase row; the resolver
      // re-derives identically on each call against the same id.
      (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValue({
        id: 'cb-relocated-artifact',
        kind: 'repo',
        name: 'new/widget',
        default_cwd: '/repos/widget',
      });

      await workflowGetCommand(createTestWorkflowHost(), runId, true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: { artifactFiles?: string[] };
      };
      expect(parsed.leave_behind?.artifactFiles).toContain('marker.txt');
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
    }
  });

  it('walks the leave-behind artifact dir under a trusted persisted output_root (#3097)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-trusted-home');
    process.env.ARCHON_HOME = archonHome;
    const runId = 'run-artifact-trusted';
    const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    const artifactsDir = join(outputRoot, 'artifacts', 'runs', runId);
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, 'note.txt'), 'ok');
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: outputRoot,
        checkout_baseline: null,
        codebase_id: 'cb-1',
      });

      await workflowGetCommand(createTestWorkflowHost(), runId, true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: { artifactFiles?: string[] };
      };
      expect(parsed.leave_behind?.artifactFiles).toContain('note.txt');
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
    }
  });

  // #3450 — the engine writes one typed-artifact listing per node invocation
  // under `$ARTIFACTS_DIR/.archon/`, so a pack run buries its reports under
  // dozens of uuid files and the display cap can drop them entirely. The
  // leave-behind list is what the archon-cli skill reads to find a run's
  // results, so it carries operator-facing files only — with a count of what it
  // left out, never a silent drop.
  it('keeps engine-internal artifact files out of the leave-behind list and counts them (#3450)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-internal-home');
    process.env.ARCHON_HOME = archonHome;
    const runId = 'run-artifact-internal';
    const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    const artifactsDir = join(outputRoot, 'artifacts', 'runs', runId);
    const reports = ['plan.md', 'validation.md', 'pr-action.md'];
    mkdirSync(join(artifactsDir, 'review'), { recursive: true });
    for (const report of reports) writeFileSync(join(artifactsDir, report), 'report');
    writeFileSync(join(artifactsDir, 'review', 'report.md'), 'report');
    // A workflow's own dotfile is its output: only the engine's child is hidden,
    // by the rule the console's artifacts route shares.
    writeFileSync(join(artifactsDir, '.pr-number'), '42');
    // Typed-artifact sidecars are real content, so they stay listed — but they
    // sort ahead of most reports and outnumber the 20-line human preview, so a
    // depth-first walk would still hide every report behind them.
    mkdirSync(join(artifactsDir, 'nodes'), { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(artifactsDir, 'nodes', `node-${String(i).padStart(2, '0')}.md`), 'output');
    }
    // More listings than the display cap: before the fix they consumed it and
    // the reports never appeared at all.
    const listingsDir = join(artifactsDir, RUN_ARTIFACTS_ENGINE_SUBDIR, 'typed-artifacts');
    mkdirSync(listingsDir, { recursive: true });
    const internalFiles = 240;
    for (let i = 0; i < internalFiles; i++) {
      writeFileSync(join(listingsDir, `${randomUUID()}.json`), '{}');
    }
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: outputRoot,
        checkout_baseline: null,
        codebase_id: 'cb-1',
      });

      await workflowGetCommand(createTestWorkflowHost(), runId, true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: {
          artifactFiles?: string[];
          artifactFilesOmitted?: {
            internalFiles: number;
            truncated: boolean;
            unreadable: string[];
          };
        };
      };
      // A run's own reports sit at the top level, so they lead the list and the
      // cap falls on nested content instead of on them.
      expect(parsed.leave_behind?.artifactFiles?.slice(0, reports.length + 1)).toEqual([
        '.pr-number',
        'plan.md',
        'pr-action.md',
        'validation.md',
      ]);
      expect(parsed.leave_behind?.artifactFiles).toContain('review/report.md');
      expect(parsed.leave_behind?.artifactFiles).toHaveLength(reports.length + 32);
      expect(
        parsed.leave_behind?.artifactFiles?.some(file =>
          file.startsWith(`${RUN_ARTIFACTS_ENGINE_SUBDIR}/`)
        )
      ).toBe(false);
      expect(parsed.leave_behind?.artifactFilesOmitted).toEqual({
        internalFiles,
        truncated: false,
        unreadable: [],
      });

      // Human output draws from the same filtered list and says what it omitted.
      await workflowGetCommand(createTestWorkflowHost(), runId);
      const printed: string = consoleSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join('\n');
      // Only the listed entries: the transcript path is absolute and may itself
      // sit under a `.archon` directory.
      const listed = printed
        .split('\n')
        .filter(line => line.startsWith('      - '))
        .map(line => line.slice('      - '.length));
      for (const report of reports) expect(listed).toContain(report);
      expect(listed.filter(file => file.startsWith(`${RUN_ARTIFACTS_ENGINE_SUBDIR}/`))).toEqual([]);
      expect(printed).toContain(`Engine-internal artifact files (not listed): ${internalFiles}`);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
    }
  });

  it('reports a truncated leave-behind artifact list rather than dropping files silently (#3450)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-truncated-home');
    process.env.ARCHON_HOME = archonHome;
    const runId = 'run-artifact-truncated';
    const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    const artifactsDir = join(outputRoot, 'artifacts', 'runs', runId);
    mkdirSync(artifactsDir, { recursive: true });
    for (let i = 0; i < 205; i++) {
      writeFileSync(join(artifactsDir, `report-${String(i).padStart(3, '0')}.md`), 'report');
    }
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: outputRoot,
        checkout_baseline: null,
        codebase_id: 'cb-1',
      });

      await workflowGetCommand(createTestWorkflowHost(), runId, true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: {
          artifactFiles?: string[];
          artifactFilesOmitted?: {
            internalFiles: number;
            truncated: boolean;
            unreadable: string[];
          };
        };
      };
      expect(parsed.leave_behind?.artifactFiles).toHaveLength(200);
      expect(parsed.leave_behind?.artifactFilesOmitted?.truncated).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
    }
  });

  // A directory the walk cannot read hides everything inside it. ENOENT means
  // the directory is simply gone and dropped nothing an operator could open;
  // anything else is a real omission that has to reach the operator. Mode 000
  // cannot make a directory unreadable on Windows or to root, which bypasses it.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'names an artifact directory it could not read rather than skipping it silently (#3450)',
    async () => {
      const previousHome = process.env.ARCHON_HOME;
      const archonHome = join(tmpdir(), 'archon-get-artifact-unreadable-home');
      process.env.ARCHON_HOME = archonHome;
      const runId = 'run-artifact-unreadable';
      const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
      const artifactsDir = join(outputRoot, 'artifacts', 'runs', runId);
      const lockedDir = join(artifactsDir, 'review');
      mkdirSync(lockedDir, { recursive: true });
      writeFileSync(join(artifactsDir, 'plan.md'), 'report');
      writeFileSync(join(lockedDir, 'report.md'), 'report');
      chmodSync(lockedDir, 0o000);
      try {
        const workflowDb = await import('@archon/core/db/workflows');
        (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
          id: runId,
          workflow_name: 'implement',
          status: 'completed',
          working_path: '/tmp/wt',
          started_at: new Date(),
          metadata: {},
          output_root: outputRoot,
          checkout_baseline: null,
          codebase_id: 'cb-1',
        });

        await workflowGetCommand(createTestWorkflowHost(), runId, true);

        const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
          leave_behind?: {
            artifactFiles?: string[];
            artifactFilesOmitted?: {
              internalFiles: number;
              truncated: boolean;
              unreadable: string[];
            };
          };
        };
        expect(parsed.leave_behind?.artifactFiles).toEqual(['plan.md']);
        expect(parsed.leave_behind?.artifactFilesOmitted).toEqual({
          internalFiles: 0,
          truncated: false,
          unreadable: ['review'],
        });

        await workflowGetCommand(createTestWorkflowHost(), runId);
        const printed = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
        expect(printed).toContain('Unreadable artifact directory: review');
      } finally {
        chmodSync(lockedDir, 0o700);
        if (previousHome === undefined) delete process.env.ARCHON_HOME;
        else process.env.ARCHON_HOME = previousHome;
        await removeTempTree(archonHome);
      }
    }
  );

  it('emits the full metadata.approval (incl. completionSignaled) in --json for a paused interactive_loop run (#2074 E)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-gate-json',
      workflow_name: 'validate',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 2,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });

    const code = await workflowGetCommand(createTestWorkflowHost(), 'run-gate-json', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      metadata: { approval: { completionSignaled: boolean; signaledOutput: string } };
    };
    // The agent read surface: the C fields flow through the CLI --json dump unchanged.
    expect(parsed.metadata.approval.completionSignaled).toBe(true);
    expect(parsed.metadata.approval.signaledOutput).toBe('REPORT');
    expect(code).toBe(0);
  });

  it('prints declared decisions and exact respond commands for a paused gate', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-choices',
      checkout_baseline: null,
      workflow_name: 'review',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          nodeId: 'review',
          type: 'approval',
          message: 'Choose',
          decisions: [
            { id: 'approve', label: 'Ship it' },
            { id: 'revise', label: 'Try again' },
            { id: 'cancel' },
          ],
        },
      },
    });
    await workflowGetCommand(createTestWorkflowHost(), 'run-choices');
    expect(consoleSpy).toHaveBeenCalledWith(
      '    Try again (revise): archon workflow respond run-choices revise [text]'
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '    cancel: archon workflow respond run-choices cancel [text]'
    );
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('respond run-choices reject');
  });

  it('lists the default vocabulary for a legacy paused gate', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-legacy',
      checkout_baseline: null,
      workflow_name: 'review',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: { approval: { nodeId: 'review', message: 'Choose' } },
    });
    await workflowGetCommand(createTestWorkflowHost(), 'run-legacy');
    expect(consoleSpy).toHaveBeenCalledWith(
      '    approve: archon workflow respond run-legacy approve [text]'
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '    reject: archon workflow respond run-legacy reject [text]'
    );
  });

  it('prints aggregate completion-condition state for a paused interactive_loop run (#2074 E)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-gate-human',
      checkout_baseline: null,
      workflow_name: 'validate',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 2,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-gate-human');

    expect(consoleSpy).toHaveBeenCalledWith(
      '  Gate:   awaiting approval — completion condition met: yes (iteration 2)'
    );
  });

  it('prints durable wait, usage-limit wait and scheduled quota continuation state', async (): Promise<void> => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        id: 'run-wait-human',
        checkout_baseline: null,
        workflow_name: 'validate',
        status: 'paused',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'checks',
            kind: 'event',
            event: 'checks.complete',
            waitingSince: '2026-08-24T10:00:00.000Z',
            resumeAt: '2026-08-25T10:00:00.000Z',
          },
        },
      })
      .mockResolvedValueOnce({
        id: 'run-limit-human',
        checkout_baseline: null,
        workflow_name: 'deliver',
        status: 'paused',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'implement',
            kind: 'quota',
            pauseId: 'limit-1',
            waitingSince: '2026-08-24T10:00:00.000Z',
            resumeAt: '2026-08-25T12:00:00.000Z',
          },
        },
      })
      .mockResolvedValueOnce({
        id: 'run-quota-human',
        checkout_baseline: null,
        workflow_name: 'deliver',
        status: 'failed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {
          scheduled_resume: {
            reason: 'quota',
            resumeAt: '2026-08-25T11:00:00.000Z',
            deadlineAt: '2026-08-26T10:00:00.000Z',
            attempt: 1,
            maxAttempts: 2,
            error: 'usage limit reached',
          },
        },
      });

    await workflowGetCommand(createTestWorkflowHost(), 'run-wait-human');
    await workflowGetCommand(createTestWorkflowHost(), 'run-limit-human');
    await workflowGetCommand(createTestWorkflowHost(), 'run-quota-human');

    expect(consoleSpy).toHaveBeenCalledWith(
      "  Wait:   event 'checks.complete' until 2026-08-25T10:00:00.000Z"
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      "  Wait:   provider usage or rate limit at 'implement' — tries again at 2026-08-25T12:00:00.000Z"
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '  Resume: scheduled for 2026-08-25T11:00:00.000Z (attempt 1/2)'
    );
  });

  it('prints an attention wait with its explicit resume command', async (): Promise<void> => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-action-human',
      checkout_baseline: null,
      workflow_name: 'deliver',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'old-gate',
          message: 'Stale approval',
          iteration: 1,
        },
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-08-24T10:00:00.000Z',
          message: 'Re-run CI, then resume.',
        },
      },
    });

    await workflowGetCommand(createTestWorkflowHost(), 'run-action-human');

    expect(consoleSpy).toHaveBeenCalledWith(
      '  Wait:   needs attention — Re-run CI, then resume. (occurrence legacy:rerun-ci)'
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '    When it is done, resume: `archon workflow resume run-action-human`'
    );
    expect(consoleSpy.mock.calls.flat().join(' ')).not.toContain('Gate:');
  });

  it('emits the same shared node summaries in verbose JSON by default', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const eventsDb = await import('@archon/core/db/workflow-events');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-v',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'running',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowGetCommand(createTestWorkflowHost(), 'run-v', true, true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      nodes: Array<Record<string, unknown>>;
      events?: unknown[];
      transcript_path?: string | null;
    };
    expect(parsed.nodes).toEqual(EXPECTED_VERBOSE_NODES);
    expect(parsed.nodes.map(node => node.state)).toEqual(
      buildNodeSummaries(VERBOSE_EVENTS_FIXTURE).map(node => node.state)
    );
    expect(parsed.events).toBeUndefined();
    expect(parsed.transcript_path).toBeNull();
  });

  it('reads attribution and observed duration from a terminal row without a start-row join', async () => {
    const { startNodeExecution, finishNodeExecution, newNodeInvocation } = await import(
      '@archon/workflows/node-execution'
    );
    const { serializeNodeStateRecord } = await import(
      '@archon/workflows/node-record-serialization'
    );
    const completed = finishNodeExecution(
      startNodeExecution({
        runId: 'terminal-only',
        path: 'work',
        node: { id: 'work', kind: 'agent', source: { kind: 'inline', prompt: 'work' } },
        invocation: newNodeInvocation(),
        provider: 'codex',
        model: 'requested-model',
      }),
      { status: 'completed' },
      { durationMs: 17, resolvedModel: 'observed-model', costUsd: 0, output: { text: 'done' } }
    );
    const summaries = buildNodeSummaries([
      {
        ...serializeNodeStateRecord(completed),
        id: 'terminal-row',
        step_index: null,
        created_at: new Date().toISOString(),
      },
    ]);
    expect(summaries[0]?.durationMs).toBe(17);
    expect(summaries[0]?.execution?.binding.model?.resolved).toEqual({
      source: 'provider',
      value: 'observed-model',
    });
    expect(summaries[0]?.execution?.spend.costUsd).toEqual({ source: 'provider', value: 0 });
  });

  it('emits raw events in verbose JSON when events=true', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const eventsDb = await import('@archon/core/db/workflow-events');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-v',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'running',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowGetCommand(createTestWorkflowHost(), 'run-v', true, true, undefined, true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      events: WorkflowEventRow[];
      nodes?: unknown[];
      transcript_path?: string | null;
    };
    expect(parsed.events).toEqual(VERBOSE_EVENTS_FIXTURE);
    expect(parsed.nodes).toBeUndefined();
    expect(parsed.transcript_path).toBeNull();
  });

  it('fails explicitly when a raw verbose JSON event query fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const eventsDb = await import('@archon/core/db/workflow-events');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-v',
      checkout_baseline: null,
      workflow_name: 'implement',
      status: 'running',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('events unavailable')
    );

    const code = await workflowGetCommand(
      createTestWorkflowHost(),
      'run-v',
      true,
      true,
      undefined,
      true
    );

    expect(code).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: false,
      runId: 'run-v',
      error: 'workflow_events_unavailable',
    });
  });
});

describe('fan-out outcome lines', () => {
  it('lists unfinished slots up to the display limit and counts the rest from the tally', () => {
    const slots: FanOutSlot[] = Array.from({ length: 40 }, (_, index): FanOutSlot => {
      if (index % 3 === 0) return { index, outcome: 'completed', child_run_id: `c${index}` };
      if (index % 3 === 1)
        return { index, outcome: 'failed', child_run_id: `c${index}`, error: 'exit 1' };
      return { index, outcome: 'not_started', error: 'refused' };
    });
    slots[2] = {
      index: 2,
      outcome: 'cancelled_out_of_band',
      child_run_id: 'c2',
      cancel_reason: 'operator',
    };
    const lines = formatFanOutOutcome(fanOutOutcome(slots));
    expect(lines[0]).toBe(
      'Fan-out work: 26 of 40 children did not complete ' +
        '(13 failed, 12 not started, 1 cancelled out of band)'
    );
    expect(lines.slice(1, 3)).toEqual([
      '  item 1: failed — run c1 — exit 1',
      '  item 2: cancelled out of band (operator) — run c2',
    ]);
    expect(lines).toHaveLength(1 + 10 + 1);
    expect(lines.at(-1)).toBe('  … and 16 more (see --json)');
    expect(
      formatFanOutOutcome(fanOutOutcome([{ index: 0, outcome: 'completed', child_run_id: 'c' }]))
    ).toEqual([]);
  });

  it('carries the slot record from a fan-out node event into its summary', () => {
    const outcome = fanOutOutcome([{ index: 0, outcome: 'not_started', error: 'refused' }]);
    const [summary] = buildNodeSummaries([
      {
        id: 'work-failed',
        workflow_run_id: 'run-fan',
        event_type: 'node_failed',
        step_name: 'work',
        step_index: null,
        data: { error: 'refused all', fan_out: true, fan_out_outcome: outcome },
        created_at: '2026-10-22T10:00:00.000Z',
      },
    ]);
    expect(summary?.fanOutOutcome).toEqual(outcome);
  });
});
