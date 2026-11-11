import { expect, test } from 'bun:test';
import type { AttentionQueueItem, AttentionQueueScope } from '@archon/workflows/attention-queue';
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import { workflowEventCursor } from '@archon/workflows/store';
import { attentionItemLines, attentionStreamText } from './workflow-attention-text';

const scope: AttentionQueueScope = { kind: 'all' };
const cursor = workflowEventCursor('c');
const run = { cursor, project: null, runId: 'run-1', workflow: 'deliver', parentRunId: null };
const base = {
  runId: 'run-1',
  workflow: 'deliver',
  project: null,
  parentRunId: null,
  fanOut: null,
  revision: 1,
  labels: { merge: 'pr', pr: '42' },
  pausedAt: null,
  context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
};
const ask: Extract<AttentionQueueItem, { kind: 'attention' }> = {
  ...base,
  kind: 'attention',
  node: 'decide',
  occurrence: 'occ-7',
  message: '\nMerge pull request 42?\n\nEvidence: three paragraphs nobody reads in a watch line.',
  form: 'select',
  options: [
    { id: 'merge', does: 'Squash-merge it.', value: { nested: ['never', 'printed'] } },
    { id: 'hold', label: 'Hold' },
  ],
  recommendation: { option: 'merge', why: 'Review is ready.', confidence: 'high' },
};
const text = (line: Exclude<AttentionStreamLine, { type: 'error' }>): string =>
  attentionStreamText(line, scope).join('\n');
const opened = (item: AttentionQueueItem): string =>
  text({ type: 'attention', ...run, snapshot: false, item });

test('an ask can be answered from its watch text alone', () => {
  const block = opened(ask);
  expect(block).toContain('deliver');
  expect(block).toContain('merge=pr');
  expect(block).toContain('Merge pull request 42?');
  expect(block).toContain('merge (high confidence). Review is ready.');
  expect(block).toContain('option merge: Squash-merge it.');
  expect(block).toContain('option hold');
  expect(block).toContain('archon workflow respond run-1 --recommended --occurrence occ-7');
  expect(block).toContain('archon workflow respond run-1 <option> --occurrence occ-7');
  // The rest of the message and an option's value stay behind the pointer.
  expect(block).toContain('archon workflow attention run-1');
  expect(block).not.toContain('Evidence');
  expect(block).not.toContain('nested');
});

test('the single read prints the whole message, and an ask without a recommendation offers none to accept', () => {
  const { recommendation: _, ...unadvised } = ask;
  const block = attentionItemLines(unadvised, 'full').join('\n');
  expect(block).toContain('Evidence: three paragraphs');
  expect(block).not.toContain('--recommended');
  expect(block).toContain('--occurrence occ-7');
});

test.each([
  ['message', 'archon workflow answer run-1 --occurrence occ-7 --text'],
  ['approval', 'archon workflow respond run-1 approve|reject --occurrence occ-7'],
  ['multi_select', 'archon workflow answer run-1 --occurrence occ-7 --choose'],
] as const)('a %s ask names the command that answers its form', (form, answer) => {
  const { recommendation: _, ...unadvised } = ask;
  expect(opened({ ...unadvised, form })).toContain(answer);
});

test('a gate names its occurrence in the answer command', () => {
  const block = opened({
    ...base,
    kind: 'awaiting_response',
    node: 'review',
    occurrence: 'gate-3',
    message: 'Ship?',
  });
  expect(block).toContain('archon workflow approve run-1 --occurrence gate-3');
});

test('an unreadable item, a failed run and a lost owner say which run and what shows more', () => {
  const more = 'archon workflow get run-1';
  expect(
    opened({ ...base, kind: 'unreadable', reason: 'malformed_gate', detail: 'no gate recorded' })
  ).toContain(more);
  const failed = text({
    type: 'terminal',
    ...run,
    status: 'failed',
    outcome: null,
    cause: { node: 'build', errorClass: 'exec_failed' },
  });
  expect(failed).toContain('run-1');
  expect(failed).toContain('build');
  expect(failed).toContain(more);
  const lost = text({ type: 'owner_lost', ...run, observedStatus: 'running' });
  expect(lost).toContain(more);
  expect(lost).toContain('archon workflow abandon run-1');
  // A run that ended well needs nobody, so it points nowhere.
  expect(
    text({ type: 'terminal', ...run, status: 'completed', outcome: null, cause: null })
  ).not.toContain(more);
});

test('the close of an ask is one line that says who answered when that was recorded', () => {
  const closed = attentionStreamText(
    {
      type: 'resolved',
      ...run,
      occurrence: 'occ-7',
      reason: 'answered',
      answeredVia: 'cli',
      answeredBy: { declared: 'triage-agent' },
      answeredAt: null,
    },
    scope
  );
  expect(closed).toHaveLength(1);
  expect(closed[0]).toContain('run-1');
  expect(closed[0]).toContain('triage-agent');
  expect(
    attentionStreamText(
      { type: 'resolved', ...run, occurrence: 'occ-7', reason: 'withdrawn' },
      scope
    )
  ).toHaveLength(1);
});
