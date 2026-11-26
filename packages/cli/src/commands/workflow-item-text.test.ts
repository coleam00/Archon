import { expect, test } from 'bun:test';
import type { ItemRead } from '@archon/workflows/item-read';
import { itemReadLines } from './workflow-item-text';

// The hosts this install drains; the fixture's starts wait on 'host'.
const SERVED: ReadonlySet<string> = new Set(['host']);

const read: ItemRead = {
  item: { id: 'item-row', projectKey: 'acme/web', key: 'issue-7' },
  standing: { runId: null, state: 'resting', pack: null },
  runs: [
    {
      id: 'run-done-1',
      workflow: 'deliver',
      pack: null,
      status: 'completed',
      outcome: 'succeeded',
      startedAt: '2026-11-01T09:00:00.000Z',
      completedAt: '2026-11-01T09:30:00.000Z',
      cause: null,
      awaitingExecution: null,
      startLimit: null,
      spend: { usd: 0.5, inputTokens: 100, outputTokens: 20 },
      heldBehind: null,
      operatorPause: null,
      hasResult: true,
      resultCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      changeSize: null,
    },
  ],
  queued: [
    {
      requestId: 'b6f1c2d4-0000-4000-8000-000000000001',
      workflow: 'review',
      resource: 'build',
      hostId: 'host',
      queuedAt: '2026-11-01T09:35:00.000Z',
      ahead: 12,
      blockedBy: null,
      heldBehind: null,
      waitsForRunLimit: false,
    },
  ],
  skipped: [],
  hold: null,
  held: [],
  runLimit: null,
  startLimits: [],
  waits: [],
  questions: [
    {
      kind: 'awaiting_response',
      project: null,
      revision: 1,
      labels: {},
      pausedAt: null,
      ref: 'run-ask-1:gate-3',
      run: {
        id: 'run-ask-1',
        workflow: 'review',
        parentRunId: 'run-done-1',
        fanOut: null,
        context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
        node: 'approve',
        occurrence: 'gate-3',
      },
      message: 'Ship the fix?',
    },
  ],
  answers: [
    {
      kind: 'gate',
      runId: 'run-done-1',
      node: 'review',
      occurrence: 'gate-1',
      at: '2026-11-01T09:20:00.000Z',
      via: 'api',
      decision: 'rejected',
      text: 'needs tests',
    },
    {
      kind: 'attention',
      runId: 'run-ask-1',
      node: 'approve',
      occurrence: 'pause-1',
      at: '2026-11-01T09:30:00.000Z',
      via: 'cli',
      answer: { decision: 'accept', text: 'scope ok' },
      by: { declared: 'triage-agent' },
      fromRun: null,
    },
    {
      kind: 'gate',
      runId: 'run-done-1',
      node: 'review',
      occurrence: 'gate-2',
      at: '2026-11-01T09:40:00.000Z',
      via: 'cli',
      decision: 'approved',
      text: null,
    },
    {
      kind: 'ruling',
      id: 'ruling-1',
      text: 'leave the chat readers for a follow-up',
      at: '2026-11-01T09:45:00.000Z',
      via: 'cli',
      by: { declared: 'operator-agent' },
      fromRun: null,
      withdrawn: { at: '2026-11-01T10:05:00.000Z', via: 'api', by: null, fromRun: null },
    },
  ],
  links: [
    {
      id: 'link-ended',
      kind: 'part_of',
      direction: 'outgoing',
      other: { id: 'order-row', projectKey: 'acme/web', key: 'order-1' },
      at: '2026-11-01T08:00:00.000Z',
      via: 'cli',
      by: null,
      fromRun: null,
      ended: {
        at: '2026-11-01T08:30:00.000Z',
        via: 'cli',
        by: { declared: 'alice' },
        fromRun: null,
      },
    },
    {
      id: 'link-out',
      kind: 'depends_on',
      direction: 'outgoing',
      other: { id: 'other-row', projectKey: 'acme/api', key: 'issue-3' },
      at: '2026-11-01T08:10:00.000Z',
      via: 'cli',
      by: null,
      fromRun: null,
      ended: null,
    },
    {
      id: 'link-in',
      kind: 'duplicate_of',
      direction: 'incoming',
      other: { id: 'dupe-row', projectKey: 'acme/web', key: 'issue-9' },
      at: '2026-11-01T08:20:00.000Z',
      via: 'cli',
      by: null,
      fromRun: null,
      ended: null,
    },
  ],
  degraded: [
    { type: 'degraded', reason: 'ruling_unreadable', rulingId: 'ruling-lost' },
    { type: 'degraded', reason: 'link_unreadable', linkId: 'link-lost' },
  ],
  landing: {
    branch: 'feat/order',
    from: { kind: 'part_of', item: { id: 'wo-row', projectKey: 'acme/web', key: 'WO-12' } },
  },
  ended: {
    kind: 'ended',
    id: 'end-1',
    reason: 'Done by hand elsewhere.',
    at: '2026-11-01T12:00:00.000Z',
    via: 'cli',
    by: { declared: 'alice' },
    fromRun: null,
  },
  workOrder: null,
  merged: {
    change: 'https://github.com/acme/web/pull/12',
    commit: null,
    at: '2026-11-01T11:00:00.000Z',
    recordedAt: '2026-11-01T11:01:00.000Z',
    via: 'cli',
    fromRun: null,
  },
};

test('a work order prints its state and names the members that keep it open', () => {
  const member = (key: string, projectKey = 'acme/web') => ({ id: `${key}-row`, projectKey, key });
  const workOrderText = (workOrder: ItemRead['workOrder']) =>
    itemReadLines({ ...read, workOrder }, SERVED).find(line => line.startsWith('Work order'));
  expect(
    workOrderText({
      state: 'open',
      members: [
        { item: member('issue-a'), state: 'open' },
        { item: member('issue-b', 'acme/api'), state: 'open' },
        { item: member('issue-c'), state: 'merged' },
      ],
    })
  ).toBe('Work order: open, 2 of 3 members open: issue-a, acme/api/issue-b');
  expect(
    workOrderText({ state: 'done', members: [{ item: member('issue-a'), state: 'ended' }] })
  ).toStartWith('Work order: done');
  const unknown = workOrderText({
    state: 'unknown',
    members: [{ item: member('issue-a'), state: 'unknown' }],
  });
  expect(unknown).toStartWith('Work order: unknown');
  expect(unknown).toContain('issue-a');
  expect(workOrderText(null)).toBeUndefined();
});

test('an unreadable member part prints under an open work order too, naming the member', () => {
  const lost = { id: 'issue-d-row', projectKey: 'acme/web', key: 'issue-d' };
  const lines = itemReadLines(
    {
      ...read,
      workOrder: {
        state: 'open',
        members: [
          { item: { id: 'issue-a-row', projectKey: 'acme/web', key: 'issue-a' }, state: 'open' },
          { item: lost, state: 'unknown' },
        ],
      },
      degraded: [
        {
          type: 'degraded',
          reason: 'member_unreadable',
          member: lost,
          report: { type: 'degraded', reason: 'merge_unreadable', itemId: lost.id },
        },
      ],
    },
    SERVED
  );
  const warning = lines.find(line => line.includes('issue-d') && line.includes('merge'));
  expect(warning).toContain('could not be read');
});

test('an item read prints its runs, open questions and answers', () => {
  const lines = itemReadLines(read, SERVED);
  const runLine = lines.find(line => line.includes('run-done'));
  expect(runLine).toContain('deliver');
  expect(runLine).toContain('completed');
  expect(runLine).toContain('succeeded');
  expect(runLine).toContain('2026-11-01T09:00Z');
  expect(runLine).toContain('2026-11-01T09:30Z');
  const text = lines.join('\n');
  expect(text).toContain('Merged 2026-11-01T11:00Z: https://github.com/acme/web/pull/12');
  expect(text).toContain('Lands on: feat/order (part_of WO-12)');
  const endLine = lines.find(line => line.includes('Done by hand elsewhere.'));
  expect(endLine).toContain('2026-11-01T12:00Z');
  expect(endLine).toContain('alice');
  expect(text).toContain('result: archon workflow get run-done-1 --json, holds at a1b2c3d4e5f6');
  expect(text).toContain('Ship the fix?');
  expect(text).toContain('archon workflow approve run-ask-1 --occurrence gate-3');
  const answerLine = lines.find(line => line.includes('needs tests'));
  expect(answerLine).toContain('2026-11-01T09:20Z');
  expect(answerLine).toContain('rejected');
  expect(answerLine).toContain('api');
  expect(text).toContain('answered accept: scope ok by triage-agent (self-declared)');
  // Answers print oldest first.
  const rejected = lines.findIndex(line => line.includes('needs tests'));
  const answered = lines.findIndex(line => line.includes('scope ok'));
  const approved = lines.findIndex(line => line.includes('gate approved'));
  expect(answered).toBeGreaterThan(rejected);
  expect(approved).toBeGreaterThan(answered);
  // A ruling prints with the answers, with who said it and that it was withdrawn.
  const ruling = lines.findIndex(line => line.includes('leave the chat readers'));
  expect(ruling).toBeGreaterThan(approved);
  expect(lines[ruling]).toContain('ruling ruling-1');
  expect(lines[ruling]).toContain('by operator-agent (self-declared)');
  expect(lines[ruling]).toContain('(withdrawn 2026-11-01T10:05Z)');
  expect(text).toContain('1 ruling(s) on this item could not be read: ruling-lost');
});

test('a start held behind a run whose owner is gone prints both actions on that run', () => {
  const holder = 'a1b2c3d4-0000-4000-8000-000000000001';
  const heldBehind = {
    runId: holder,
    workflow: 'deliver',
    status: 'running',
    owner: 'unreachable',
  } as const;
  const text = itemReadLines(
    {
      ...read,
      // No run carries the holder, so only the start's own line can name it.
      runs: [],
      queued: [{ ...read.queued[0]!, requestId: 'req-queued', workflow: 'deliver', heldBehind }],
    },
    SERVED
  ).join('\n');
  expect(text).toContain('req-queued');
  expect(text).toContain(`waits behind run ${holder.slice(0, 8)}`);
  expect(text).toContain(`archon workflow resume ${holder}`);
  expect(text).toContain(`archon workflow abandon ${holder}`);
});

test('an admitted start shows the execute command only when nobody runs it', () => {
  const requestId = 'c7d8e9f0-0000-4000-8000-000000000001';
  const textFor = (
    state: 'starting' | 'unowned' | 'unknown',
    executor: { host: string; pid: number } | null
  ) =>
    itemReadLines(
      {
        ...read,
        queued: [],
        runs: [
          {
            ...read.runs[0]!,
            id: requestId,
            status: 'pending',
            outcome: null,
            completedAt: null,
            hasResult: false,
            resultCommit: null,
            changeSize: null,
            awaitingExecution: { requestId, hostId: 'host', state, executor },
          },
        ],
      },
      SERVED
    ).join('\n');
  const execute = `archon trigger execute ${requestId} --host host`;
  expect(textFor('starting', { host: 'here', pid: 4242 })).not.toContain('archon trigger');
  expect(textFor('unowned', null)).toContain(execute);
  const unknown = textFor('unknown', { host: 'elsewhere', pid: 4242 });
  expect(unknown).toContain(`archon trigger inspect ${requestId}`);
  expect(unknown).not.toContain(execute);
});

test('a start refused for a held item keeps naming the run that held it', () => {
  const holder = 'a1b2c3d4-0000-4000-8000-000000000001';
  const text = itemReadLines(
    {
      ...read,
      runs: [
        {
          ...read.runs[0]!,
          id: 'run-refused',
          status: 'cancelled',
          outcome: null,
          heldBehind: { runId: holder, workflow: 'deliver', status: 'completed', owner: null },
        },
      ],
    },
    SERVED
  ).join('\n');
  expect(text).toContain(`refused, held by run ${holder.slice(0, 8)}`);
});

test('a queued start behind an unreadable request names it instead of what would admit it', () => {
  const [queued] = read.queued;
  if (queued === undefined) throw new Error('no queued start');
  const lines = itemReadLines({ ...read, queued: [{ ...queued, blockedBy: 'q-head' }] }, SERVED);
  const section = lines.slice(lines.indexOf('Waiting to start:') + 1, lines.indexOf('Links:'));
  expect(section.join('\n')).toContain('request q-head ahead of it cannot be read');
  expect(section.join('\n')).toContain('archon trigger withdraw q-head');
  expect(section.join('\n')).not.toContain('wake watcher');
});

test('an item read prints a start waiting for capacity with the id that withdraws it', () => {
  const lines = itemReadLines(read, SERVED);
  const section = lines.slice(lines.indexOf('Waiting to start:') + 1, lines.indexOf('Links:'));
  expect(section).toHaveLength(3);
  expect(section[0]).toContain('b6f1c2d4-0000-4000-8000-000000000001');
  expect(section[0]).toContain('build');
  expect(section[0]).toContain('12 ahead on host host');
  // What admits it: this install's run ends and wake passes, or the host's own drain.
  expect(section[1]).toContain('wake watcher');
  expect(section[1]).toContain('archon trigger drain --host host');
  const elsewhere = itemReadLines(read, new Set());
  expect(elsewhere.join('\n')).toContain('no trigger file on this install names host host');
  // The host that must drain the start shows when it is next, too.
  const next = itemReadLines(
    {
      ...read,
      queued: read.queued.map(start => ({ ...start, ahead: 0 })),
    },
    SERVED
  );
  expect(next.find(line => line.includes('b6f1c2d4'))).toContain('on host host');
  // A start only the run limit holds says so, with the count, in place of its queue place.
  const limited = itemReadLines(
    {
      ...read,
      runLimit: { limit: 2, live: 1 },
      queued: read.queued.map(start => ({ ...start, waitsForRunLimit: true })),
    },
    SERVED
  );
  expect(limited.find(line => line.includes('b6f1c2d4'))).toContain(
    'waits for the run limit (1 of 2 runs at once on this install) on host host'
  );
  const empty = itemReadLines({ ...read, queued: [] }, SERVED);
  expect(empty[empty.indexOf('Waiting to start:') + 1]).toBe('  none');
});

test('an unprepared start names what prepares it: the install hold, or its host', () => {
  const start = {
    receiptId: 'receipt-1',
    bindingId: 'build-after-answers',
    hostId: 'host',
    workflow: 'build',
    receivedAt: '2026-11-01T09:40:00.000Z',
  };
  const waiting = itemReadLines({ ...read, queued: [], held: [start] }, SERVED).join('\n');
  expect(waiting).toContain('receipt receipt-1');
  expect(waiting).toContain('waits to be prepared on host host');
  expect(waiting).toContain('archon trigger drain --host host');
  const hold = {
    setBy: 'operator',
    setAt: '2026-11-01T09:30:00.000Z',
  } as const;
  const held = itemReadLines({ ...read, queued: [], held: [start], hold }, SERVED).join('\n');
  expect(held).toContain('waits for the install hold');
  expect(held).not.toContain('archon trigger drain');
});

test('the waiting section says when the run limit is full, and only then', () => {
  const lines = (runLimit: ItemRead['runLimit']) => itemReadLines({ ...read, runLimit }, SERVED);
  const full = lines({ limit: 2, live: 2 });
  expect(full[full.indexOf('Waiting to start:') + 1]).toBe(
    '  The run limit is full (2 of 2 runs at once on this install); nothing new starts until a run ends.'
  );
  for (const room of [null, { limit: 3, live: 2 }])
    expect(lines(room).some(line => line.includes('run limit'))).toBe(false);
});

test('an item read prints each link with the other item, kind and direction', () => {
  const lines = itemReadLines(read, SERVED);
  const section = lines.slice(lines.indexOf('Links:') + 1, lines.indexOf('Open questions:'));
  const line = (id: string) => section.find(row => row.includes(id)) ?? '';
  expect(line('link-out')).toContain('depends_on');
  expect(line('link-out')).toContain('acme/api/issue-3');
  expect(line('link-in')).toContain('duplicate_of');
  expect(line('link-in')).toContain('issue-9');
  // A link reads from its `from` to its `to`: the other item follows the kind on an
  // outgoing link and precedes it on an incoming one.
  const out = line('link-out');
  expect(out.indexOf('acme/api/issue-3')).toBeGreaterThan(out.indexOf('depends_on'));
  const inc = line('link-in');
  expect(inc.indexOf('issue-9')).toBeLessThan(inc.indexOf('duplicate_of'));
  expect(line('link-ended')).toContain('part_of');
  expect(line('link-ended')).toContain('order-1');
  expect(line('link-ended')).toContain('alice');
  expect(line('link-ended')).toContain('2026-11-01T08:30Z');
  expect(line('link-out')).not.toContain('ended');
  expect(section.some(row => row.includes('link-lost'))).toBe(true);
});

test('a result that holds at a commit prints it even when the result is not readable', () => {
  const text = itemReadLines(
    {
      ...read,
      runs: read.runs.map(run => ({ ...run, id: 'run-truncated', hasResult: false })),
    },
    SERVED
  ).join('\n');
  expect(text).toContain('result: holds at a1b2c3d4e5f6');
  expect(text).not.toContain('archon workflow get run-truncated');
});
