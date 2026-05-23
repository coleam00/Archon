import { describe, test, expect } from 'bun:test';
import { formatStepLogLines } from './format-step-logs';
import type { WorkflowEventResponse } from './api';

function event(partial: Partial<WorkflowEventResponse>): WorkflowEventResponse {
  return {
    id: 'evt-1',
    workflow_run_id: 'run-1',
    event_type: 'node_completed',
    step_index: null,
    step_name: 'e',
    data: {},
    created_at: '2026-05-23T09:05:43.000Z',
    ...partial,
  };
}

describe('formatStepLogLines', () => {
  test('returns [] when no node is selected', () => {
    expect(formatStepLogLines([event({})], null)).toEqual([]);
  });

  test('filters to the selected node', () => {
    const lines = formatStepLogLines(
      [
        event({ step_name: 'a', event_type: 'node_started' }),
        event({ step_name: 'e', event_type: 'node_started' }),
      ],
      'e'
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Node started: e');
  });

  test('appends node_output as indented lines beneath the completed summary', () => {
    const lines = formatStepLogLines(
      [event({ step_name: 'e', data: { type: 'bash', node_output: 'captured: paprika' } })],
      'e'
    );
    // One line for the summary, one for the output — separate array entries so the
    // virtualizer's fixed-height rows stay accurate.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Node completed: e');
    expect(lines[1]).toBe('  captured: paprika');
  });

  test('splits multi-line output into one entry per line', () => {
    const lines = formatStepLogLines(
      [event({ step_name: 'e', data: { node_output: 'line1\nline2' } })],
      'e'
    );
    expect(lines).toEqual([
      lines[0]!, // summary (timestamp-dependent)
      '  line1',
      '  line2',
    ]);
    expect(lines[0]).toContain('Node completed: e');
  });

  test('emits only the summary when there is no output', () => {
    const lines = formatStepLogLines([event({ step_name: 'e', data: {} })], 'e');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Node completed: e');
  });

  test('formats node_failed with its error', () => {
    const lines = formatStepLogLines(
      [event({ step_name: 'e', event_type: 'node_failed', data: { error: 'boom' } })],
      'e'
    );
    expect(lines[0]).toContain('Node failed: e: boom');
  });
});
