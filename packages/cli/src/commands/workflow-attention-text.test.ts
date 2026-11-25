import { expect, test } from 'bun:test';
import type { AttentionQueueItem, AttentionQueueScope } from '@archon/workflows/attention-queue';
import type { AttentionStreamLine } from '@archon/workflows/attention-watch';
import { workflowEventCursor } from '@archon/workflows/store';
import { attentionItemLines, attentionStreamText } from './workflow-attention-text';

const scope: AttentionQueueScope = { kind: 'all' };
const cursor = workflowEventCursor('c');
const run = { cursor, project: null, runId: 'run-1', workflow: 'deliver', parentRunId: null };
const base = { project: null, revision: 1, labels: { merge: 'pr', pr: '42' }, pausedAt: null };
const held = {
  id: 'run-1',
  workflow: 'deliver',
  parentRunId: null,
  fanOut: null,
  context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
};
const ask: Extract<AttentionQueueItem, { kind: 'attention' }> = {
  ...base,
  kind: 'attention',
  ref: 'run-1:occ-7',
  run: { ...held, node: 'decide', occurrence: 'occ-7' },
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
    ref: 'run-1:gate-3',
    run: { ...held, node: 'review', occurrence: 'gate-3' },
    message: 'Ship?',
  });
  expect(block).toContain('archon workflow approve run-1 --occurrence gate-3');
});

test('an unreadable item, a failed run and a lost owner say which run and what shows more', () => {
  const more = 'archon workflow get run-1';
  expect(
    opened({
      ...base,
      kind: 'unreadable',
      ref: 'run-1',
      run: held,
      reason: 'malformed_gate',
      detail: 'no gate recorded',
    })
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
  // The reason the stream recorded rides under the line, so the look starts informed.
  const red = text({
    type: 'terminal',
    ...run,
    status: 'completed',
    outcome: 'failed',
    cause: null,
    reason: ['summary: main is red: lint fails on dev.'],
  });
  expect(red).toContain('summary: main is red: lint fails on dev.');
  expect(red).toContain(more);
  const lost = text({ type: 'owner_lost', ...run, observedStatus: 'running', item: 'issue-7' });
  expect(lost).toContain(more);
  expect(lost).toContain('item issue-7');
  expect(lost).toContain('archon workflow resume run-1');
  expect(lost).toContain('archon workflow abandon run-1');
  // The list's item for the same holder names its item and both actions too.
  const listed = opened({
    ...base,
    kind: 'owner_lost',
    ref: 'run-1',
    item: { id: 'item-row', projectKey: 'acme/web', key: 'issue-7' },
    run: held,
    observedStatus: 'paused',
  });
  expect(listed).toContain('item issue-7');
  expect(listed).toContain('archon workflow resume run-1');
  expect(listed).toContain('archon workflow abandon run-1');
  // A run that ended well needs nobody, so it points nowhere.
  expect(
    text({ type: 'terminal', ...run, status: 'completed', outcome: null, cause: null })
  ).not.toContain(more);
  expect(
    text({ type: 'terminal', ...run, status: 'completed', outcome: null, cause: null })
  ).toContain('Run run-1 completed.');
  expect(
    text({ type: 'terminal', ...run, status: 'completed', outcome: 'built', cause: null })
  ).toContain('Run run-1 completed (built).');
});

test('the close of an ask is one line that says who answered when that was recorded', () => {
  const closed = attentionStreamText(
    {
      type: 'resolved',
      ...run,
      ref: 'run-1:occ-7',
      occurrence: 'occ-7',
      reason: 'answered',
      answeredVia: 'cli',
      answeredBy: { declared: 'triage-agent' },
      answeredFromRun: { runId: 'run-9', nodePath: 'triage.decide' },
      answeredAt: null,
    },
    scope
  );
  expect(closed).toHaveLength(1);
  expect(closed[0]).toContain('run-1');
  expect(closed[0]).toContain('triage-agent');
  expect(closed[0]).toContain('from run run-9 (node triage.decide)');
  expect(
    attentionStreamText(
      { type: 'resolved', ...run, ref: 'run-1:occ-7', occurrence: 'occ-7', reason: 'withdrawn' },
      scope
    )
  ).toHaveLength(1);
});

test('an item no run holds is named by its ref and answered by it, not by a run command', () => {
  const { run: _, ...withoutRun } = ask;
  const block = opened({
    ...withoutRun,
    ref: 'ask:1',
    context: 'Review passed.\nMerging now blocks the Friday deploy.',
  });
  expect(block).toContain('ask:1');
  expect(block).toContain('Merge pull request 42?');
  expect(block).toContain('option merge: Squash-merge it.');
  expect(block).toContain('archon workflow answer --ref ask:1 --choose <option>');
  // The listing is the only text read of an ask, so its whole context is in it.
  expect(block).toContain('context: Review passed.');
  expect(block).toContain('Merging now blocks the Friday deploy.');
  // An open ask, not a paused run, with the item it belongs to and its whole question.
  const long = `Merge pull request 42 ${'and its follow-up '.repeat(20)}now?`;
  const listed = attentionItemLines(
    {
      ...withoutRun,
      ref: 'ask:2',
      message: long,
      item: { id: 'item-row', projectKey: 'acme/widgets', key: 'issues/42' },
    },
    'brief'
  ).join('\n');
  expect(listed).toContain('ask:2  open ask');
  expect(listed).toContain('item issues/42');
  expect(listed).toContain(long);
  expect(listed).not.toContain('paused');
  expect(
    text({
      type: 'resolved',
      cursor,
      project: null,
      ref: 'ask:1',
      workflow: null,
      parentRunId: null,
      occurrence: null,
      reason: 'no_longer_listed',
    })
  ).toBe('Item ask:1 is no longer listed.');
});

test('an ask with no recommendation says it has none and offers none to accept', () => {
  const { run: _, recommendation: _none, ...withoutRun } = ask;
  const block = opened({
    ...withoutRun,
    ref: 'ask:3',
    askedIn: { runId: 'run-plan', workflow: 'plan' },
  });
  expect(block).toContain('recommended: none (choose an option)');
  expect(block).not.toContain('--recommended');
  expect(block).toContain('archon workflow answer --ref ask:3 --choose <option>');
  const reasoned = opened({
    ...withoutRun,
    ref: 'ask:3',
    askedIn: { runId: 'run-plan', workflow: 'plan' },
    noRecommendation: 'Only you can weigh the deadline.',
  });
  expect(reasoned).toContain('no recommendation: Only you can weigh the deadline.');
  expect(reasoned).not.toContain('recommended: none');
});

test('a refused start names its item, its reason and what moves it on', () => {
  const start = {
    receiptId: 'r-1',
    bindingId: 'build',
    hostId: 'h1',
    workflow: 'build',
    itemKey: 'issue-1',
  };
  const lines = (
    reason: string,
    limit?: {
      name: string;
      starts: number;
      granted: number;
      used: number;
      bindingId: string;
      workflow: string;
    }
  ) =>
    attentionItemLines(
      {
        ...base,
        kind: 'refused_start',
        ref: 'refused:r-1:build',
        start: { ...start, reason, ...(limit === undefined ? {} : { limit }) },
      },
      'brief'
    ).join('\n');
  const provider = lines('no_default_provider');
  expect(provider).toContain('refused start');
  expect(provider).toContain('on item issue-1');
  expect(provider).toContain('archon ai default <provider>');
  expect(provider).toContain('archon trigger inspect r-1');
  const limited = lines('start_limit', {
    name: 'rounds',
    starts: 1,
    granted: 0,
    used: 1,
    bindingId: 'build',
    workflow: 'build',
  });
  expect(limited).toContain("start limit 'rounds': 1 of 1 starts used");
  // A code a newer binary wrote reads as it is.
  expect(lines('file_setting_missing')).toContain('file_setting_missing');
});

test('a stopped item names its stage and outcome, and its commands work from any directory', () => {
  const stopped: Extract<AttentionQueueItem, { kind: 'stopped' }> = {
    ...base,
    kind: 'stopped',
    ref: 'stopped:run-9',
    item: { id: 'i-1', projectKey: 'acme/web', key: 'release 1' },
    stoppedIn: { runId: 'run-9', workflow: 'deliver', outcome: 'replan' },
    summary: 'The plan missed the schema change.',
    checkout: '/srv/acme web',
  };
  const block = attentionItemLines(stopped, 'brief').join('\n');
  expect(block).toContain("deliver ended as 'replan'");
  expect(block).toContain('The plan missed the schema change.');
  // Read through the run, and started in the project's checkout, whatever the reader's directory.
  expect(block).toContain('archon workflow runs --item-of run-9');
  // Each value one shell word, whatever it holds.
  expect(block).toContain(
    "archon workflow run <workflow> --item 'release 1' --cwd '/srv/acme web'"
  );

  // Stopped by a start refused at its limit: it names the limit and starts that workflow.
  const limited = attentionItemLines(
    {
      ...stopped,
      limit: {
        name: 'build-rounds',
        starts: 2,
        granted: 1,
        used: 3,
        bindingId: 'b',
        workflow: 'build',
      },
    },
    'brief'
  ).join('\n');
  expect(limited).toContain("'build-rounds'");
  expect(limited).toContain('3 of 3');
  expect(limited).toContain("archon workflow run build --item 'release 1' --cwd '/srv/acme web'");
});
