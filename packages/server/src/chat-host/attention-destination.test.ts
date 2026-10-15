import { expect, test } from 'bun:test';
import { chatAttentionNoticeSchema } from '@archon/chat-contract';
import type { AttentionNotice } from '@archon/core/services/attention-notices';
import { attentionNoticeKindSchema } from '@archon/workflows/schemas/attention-notice';
import { attentionFormSchema } from '@archon/workflows/schemas/dag-node';
import { suspendReasonSchema } from '@archon/workflows/schemas/node-state';
import {
  terminalWorkflowRunStatusSchema,
  type WorkflowRun,
} from '@archon/workflows/schemas/workflow-run';
import { chatAttentionNotice } from './attention-destination';

test('wire copies of engine vocabularies match the engine', () => {
  const [gate, attention, terminal] = chatAttentionNoticeSchema.options;
  expect([gate.shape.type.value, attention.shape.type.value, terminal.shape.type.value]).toEqual(
    attentionNoticeKindSchema.options
  );
  expect(attention.shape.form.options).toEqual(attentionFormSchema.options);
  expect(gate.shape.gateType.options).toEqual(
    suspendReasonSchema.options.filter(
      reason => reason !== 'child_workflow' && reason !== 'fan_out'
    )
  );
  expect(terminal.shape.status.options).toEqual(terminalWorkflowRunStatusSchema.options);
});

function notice(
  kind: AttentionNotice['kind'],
  status: WorkflowRun['status'],
  metadata: Record<string, unknown>,
  outcome: WorkflowRun['outcome'] = null
): AttentionNotice {
  return {
    kind,
    destination: 'fixture-chat:ops',
    key: 'key',
    run: {
      origin: null,
      id: 'run',
      workflow_name: 'nightly',
      conversation_id: null,
      parent_conversation_id: null,
      codebase_id: null,
      status,
      outcome,
      user_message: 'private input',
      metadata,
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      working_path: '/private/path',
      user_id: null,
      parent_run_id: null,
      adopted_from_run_id: null,
      output_root: null,
      checkout_baseline: null,
    },
  };
}
const wait = {
  kind: 'attention',
  owner: 'node',
  nodeId: 'hold',
  waitingSince: '2026-10-13T01:00:00.000Z',
  message: 'Pick a base',
};

test('gates carry their type and decisions; legacy and loop gates get the default pair', () => {
  expect(
    chatAttentionNotice(
      notice('gate', 'paused', {
        approval: { nodeId: 'loop', pauseId: 'p1', message: 'Iterate?', type: 'interactive_loop' },
      })
    )
  ).toEqual({
    type: 'gate',
    runId: 'run',
    workflowName: 'nightly',
    nodeId: 'loop',
    pauseId: 'p1',
    gateType: 'interactive_loop',
    message: 'Iterate?',
    decisions: [{ id: 'approve' }, { id: 'reject' }],
  });
  expect(
    chatAttentionNotice(
      notice('gate', 'paused', {
        approval: {
          nodeId: 'review',
          message: 'Ship?',
          decisionsAuthored: true,
          decisions: [{ id: 'ship', label: 'Ship' }, { id: 'rework' }],
        },
      })
    )
  ).toEqual({
    type: 'gate',
    runId: 'run',
    workflowName: 'nightly',
    nodeId: 'review',
    gateType: 'approval',
    message: 'Ship?',
    decisions: [{ id: 'ship', label: 'Ship' }, { id: 'rework' }],
  });
});

test('attention waits carry their form, options and pause identity when they have one', () => {
  const options = [{ id: 'use-main', label: 'Main' }, { id: 'use-dev' }];
  expect(
    chatAttentionNotice(
      notice('attention', 'paused', {
        wait: { ...wait, pauseId: 'p2', form: 'select', options },
      })
    )
  ).toEqual({
    type: 'attention',
    runId: 'run',
    workflowName: 'nightly',
    nodeId: 'hold',
    pauseId: 'p2',
    message: 'Pick a base',
    form: 'select',
    options,
  });
  expect(chatAttentionNotice(notice('attention', 'paused', { wait }))).toEqual({
    type: 'attention',
    runId: 'run',
    workflowName: 'nightly',
    nodeId: 'hold',
    message: 'Pick a base',
    form: 'message',
    options: [],
  });
});

test('terminal notices carry status, authored outcome and cost', () => {
  expect(
    chatAttentionNotice(notice('terminal', 'failed', { total_cost_usd: 0.25 }, 'failed'))
  ).toEqual({
    type: 'terminal',
    runId: 'run',
    workflowName: 'nightly',
    status: 'failed',
    authoredOutcome: 'failed',
    totalCostUsd: 0.25,
  });
});

test('a run that moved after selection is not projected', () => {
  expect(() => chatAttentionNotice(notice('gate', 'completed', {}))).toThrow('no longer paused');
  expect(() => chatAttentionNotice(notice('attention', 'paused', {}))).toThrow('no longer paused');
  expect(() => chatAttentionNotice(notice('terminal', 'paused', { wait }))).toThrow(
    'has not finished'
  );
});
