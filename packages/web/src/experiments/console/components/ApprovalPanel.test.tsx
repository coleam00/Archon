import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { toRun, type Run } from '../primitives/run';
import { ApprovalPanel } from './ApprovalPanel';

function pausedRun(pauseId?: string): Run {
  return toRun({
    id: 'review-run',
    workflow_name: 'review',
    codebase_id: null,
    status: 'paused',
    started_at: '2026-10-05T10:00:00Z',
    metadata: {
      approval: {
        nodeId: 'review-gate',
        pauseId,
        message: 'Review the plan',
        decisions: [{ id: 'approve' }, { id: 'revise', label: 'Revise plan' }, { id: 'escalate' }],
        decisionsAuthored: true,
      },
    },
  });
}

describe('ApprovalPanel', () => {
  test('keeps the API pause identity and remounts the form when the same node re-pauses', () => {
    const before = pausedRun('pause-before');
    const after = pausedRun('pause-after');
    expect(before.approval?.pauseId).toBe('pause-before');
    expect(after.approval?.pauseId).toBe('pause-after');
    const firstPanel = ApprovalPanel({ run: before });
    expect(ApprovalPanel({ run: before }).key).toBe(firstPanel.key);
    expect(ApprovalPanel({ run: after }).key).not.toBe(firstPanel.key);
    expect(ApprovalPanel({ run: pausedRun() }).key).not.toBe(firstPanel.key);
    expect(ApprovalPanel({ run: { ...before, id: 'other-run' } }).key).not.toBe(firstPanel.key);
  });

  test('renders the declared decisions from the API snapshot', () => {
    const html = renderToStaticMarkup(<ApprovalPanel run={pausedRun('pause-before')} />);
    expect(html).not.toContain('Continue');
    expect(html).toContain('Approve');
    expect(html).toContain('Revise plan');
    expect(html).toContain('Escalate');
    expect(html).not.toContain('Reject');
  });
  test.each([
    {
      decisions: [
        { id: 'answer', label: 'Answer question' },
        { id: 'approve', label: 'Ship plan' },
        { id: 'reject', label: 'Discard plan' },
      ],
    },
    {
      decisions: [
        { id: 'accept', label: 'Accept plan' },
        { id: 'revise', label: 'Revise plan' },
      ],
    },
  ])('renders only authored buttons with their labels (%j)', ({ decisions }) => {
    const run = pausedRun();
    if (!run.approval) throw new Error('Expected approval');
    run.approval.decisions = [...decisions];
    const html = renderToStaticMarkup(<ApprovalPanel run={run} />);
    expect(html).not.toContain('Continue');
    expect(html.match(/<button /g)?.length).toBe(decisions.length);
    for (const decision of decisions) expect(html).toContain(decision.label);
  });

  test('keeps Continue and Reject for gates without authored decisions', () => {
    const run = pausedRun();
    if (!run.approval) throw new Error('Expected approval');
    run.approval.decisionsAuthored = false;
    run.approval.decisions = [{ id: 'approve' }, { id: 'reject' }];
    const html = renderToStaticMarkup(<ApprovalPanel run={run} />);
    expect(html).toContain('Continue');
    expect(html).toContain('Reject');
    expect(html.match(/<button /g)?.length).toBe(2);
  });
});

test.each(['/workflow approve child-full-id', 'Sub-run is paused awaiting review.'])(
  'child approval renders command-free guidance from structured identity (%s)',
  message => {
    const run = toRun({
      id: 'parent',
      workflow_name: 'parent',
      codebase_id: null,
      status: 'paused',
      started_at: '2026-10-05T10:00:00Z',
      attention: {
        kind: 'blocked_on_child',
        runId: 'parent',
        nodeId: 'sub',
        childRunId: 'child-full-id',
      },
      metadata: {
        approval: {
          nodeId: 'sub',
          type: 'child_workflow',
          childRunId: 'child-full-id',
          message,
          decisions: [{ id: 'approve' }, { id: 'reject' }],
        },
      },
    });
    const html = renderToStaticMarkup(<ApprovalPanel run={run} />);
    expect(html).toContain('child-full-id');
    expect(html).not.toContain('/workflow ');
    expect(html).not.toContain('/archon-workflow ');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('data-keymap-');
  }
);

test('fan-out parent names every child without offering parent responses', () => {
  const run = toRun({
    id: 'parent',
    workflow_name: 'parent',
    codebase_id: null,
    status: 'paused',
    started_at: '2026-10-05T10:00:00Z',
    attention: {
      kind: 'blocked_on_children',
      runId: 'parent',
      nodeId: 'parallel',
      childRunIds: ['first-child-id', 'second-child-id'],
    },
    metadata: {
      approval: {
        nodeId: 'parallel',
        type: 'fan_out',
        childRunIds: ['first-child-id', 'second-child-id'],
        message: 'Waiting on parallel sub-runs.',
        decisions: [{ id: 'approve' }, { id: 'reject' }],
      },
    },
  });
  const html = renderToStaticMarkup(<ApprovalPanel run={run} />);
  expect(html).toContain('first-child-id');
  expect(html).toContain('second-child-id');
  expect(html).not.toContain('/workflow ');
  expect(html).not.toContain('/archon-workflow ');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('data-keymap-');
});
