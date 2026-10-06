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
    expect(html).toContain('Continue');
    expect(html).toContain('Revise plan');
    expect(html).toContain('Escalate');
    expect(html).not.toContain('Reject');
  });
});
