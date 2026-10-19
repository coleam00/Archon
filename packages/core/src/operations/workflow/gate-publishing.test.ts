// @archon-test-isolated
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'fs';
import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  operator,
  mockGetWorkflowRun,
  mockResolveApprovalGate,
  mockResolveAndCancelApprovalGate,
  mockLogger,
  makePausedRun,
  approveWorkflow,
  rejectWorkflow,
  respondToWorkflow,
} from './test-harness';

describe('gate decisions in the run transcript', () => {
  // The approving process is usually not the one that ran the run, so the row has to
  // reach the run's own transcript through the persisted `output_root`.
  const originalArchonHome = process.env.ARCHON_HOME;
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'archon-gate-transcript-'));
    process.env.ARCHON_HOME = home;
    root = join(home, 'workspaces', 'acme', 'widget');
    mockGetWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
  });

  afterEach(async () => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    await removeTempTree(home);
  });

  async function transcriptRows(): Promise<Record<string, unknown>[]> {
    const path = join(root, 'logs', 'run-1.jsonl');
    if (!existsSync(path)) return [];
    return (await readFile(path, 'utf-8'))
      .trim()
      .split('\n')
      .map((line): Record<string, unknown> => {
        const row: unknown = JSON.parse(line);
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
          throw new Error(`transcript line is not a JSON object: ${line}`);
        }
        return Object.fromEntries(Object.entries(row));
      });
  }

  async function decisionRows(): Promise<Record<string, unknown>[]> {
    return (await transcriptRows()).filter(row => row.type === 'gate_decision');
  }

  test('an approval writes one decision row with the comment the DB event stores', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ output_root: root }));

    await approveWorkflow('run-1', 'Looks good', operator, { via: 'cli' });

    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'gate_decision',
      workflow_id: 'run-1',
      step: 'review',
      decision: 'approved',
      content: 'Looks good',
    });
  });

  test('a rejection that cancels the run writes its decision row with the reason', async () => {
    // No on_reject: the run is cancelled and never resumes, so this row is the only
    // transcript record of why it stopped.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ output_root: root }));

    await rejectWorkflow('run-1', 'wrong approach', operator, { via: 'cli' });

    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step: 'review',
      decision: 'rejected',
      content: 'wrong approach',
    });
  });

  test('a write-back rejection writes a decision row with no comment', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        output_root: root,
        metadata: {
          approval: { nodeId: '__writeback__', message: '7 files changed', type: 'writeback' },
        },
      })
    );

    await rejectWorkflow('run-1', undefined, operator, { via: 'cli' });

    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: '__writeback__', decision: 'rejected' });
    expect(rows[0]).not.toHaveProperty('content');
  });

  test('a declared decision writes its decision row with the response text', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        output_root: root,
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Continue?',
            type: 'approval',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      })
    );

    await respondToWorkflow('run-1', 'revise', 'tighten the tests', operator, { via: 'cli' });

    const rows = await decisionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      step: 'review',
      decision: 'revise',
      content: 'tighten the tests',
    });
  });

  test('a run with no recorded transcript location skips the row and says so', async () => {
    // A run whose identity lookup faulted never persisted its location; guessing a root
    // would start a second transcript no reader connects to the run.
    mockLogger.warn.mockClear();
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ output_root: null }));

    await approveWorkflow('run-1', 'Looks good', operator, { via: 'cli' });

    expect(await decisionRows()).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        steps: ['review', 'review'],
        eventTypes: ['node_completed', 'approval_received'],
      },
      'workflow.gate_transcript_root_missing'
    );
  });

  test('a gate paused before execution metadata existed skips its completion row and says so', async () => {
    // The gate decision still reaches the transcript, so a missing completion row with
    // no log would leave an operator no way to know the approval was never completed.
    mockLogger.warn.mockClear();
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ output_root: root }));

    await approveWorkflow('run-1', 'Looks good', operator, { via: 'cli' });

    // Unfiltered: the decision row is the only thing this resolution may write, so
    // "the completion row was skipped" is a claim about the whole transcript.
    const rows = await transcriptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'gate_decision', step: 'review' });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { runId: 'run-1', step: 'review' },
      'workflow.gate_transcript_metadata_missing'
    );
  });

  test('a resolution that loses the race writes no decision row', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ output_root: root }));
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(approveWorkflow('run-1', 'late', operator, { via: 'cli' })).rejects.toThrow(
      /already resolved/
    );

    expect(await decisionRows()).toEqual([]);
  });
});
