import { expect, test } from 'bun:test';
import type { ItemRead } from '@archon/workflows/item-read';
import { itemReadLines } from './workflow-item-text';

const read: ItemRead = {
  item: { id: 'item-row', projectKey: 'acme/web', key: 'issue-7' },
  runs: [
    {
      id: 'run-done-1',
      workflow: 'deliver',
      status: 'completed',
      outcome: 'succeeded',
      startedAt: '2026-11-01T09:00:00.000Z',
      completedAt: '2026-11-01T09:30:00.000Z',
      cause: null,
      awaitingExecution: null,
      spend: { usd: 0.5, inputTokens: 100, outputTokens: 20 },
      heldBehind: null,
      operatorPause: null,
      hasResult: true,
      resultCommit: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
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
      heldBehind: null,
    },
  ],
  skipped: [],
  hold: null,
  held: [],
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
  merged: {
    change: 'https://github.com/acme/web/pull/12',
    commit: null,
    at: '2026-11-01T11:00:00.000Z',
    recordedAt: '2026-11-01T11:01:00.000Z',
    via: 'cli',
    fromRun: null,
  },
};

test('an item read prints its runs, open questions and answers', () => {
  const lines = itemReadLines(read);
  const runLine = lines.find(line => line.includes('run-done'));
  expect(runLine).toContain('deliver');
  expect(runLine).toContain('completed');
  expect(runLine).toContain('succeeded');
  expect(runLine).toContain('2026-11-01T09:00Z');
  expect(runLine).toContain('2026-11-01T09:30Z');
  const text = lines.join('\n');
  expect(text).toContain('Merged 2026-11-01T11:00Z: https://github.com/acme/web/pull/12');
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
  const text = itemReadLines({
    ...read,
    // No run carries the holder, so only the start's own line can name it.
    runs: [],
    queued: [{ ...read.queued[0]!, requestId: 'req-queued', workflow: 'deliver', heldBehind }],
  }).join('\n');
  expect(text).toContain('req-queued');
  expect(text).toContain(`waits behind run ${holder.slice(0, 8)}`);
  expect(text).toContain(`archon workflow resume ${holder}`);
  expect(text).toContain(`archon workflow abandon ${holder}`);
});

test('a start refused for a held item keeps naming the run that held it', () => {
  const holder = 'a1b2c3d4-0000-4000-8000-000000000001';
  const text = itemReadLines({
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
  }).join('\n');
  expect(text).toContain(`refused, held by run ${holder.slice(0, 8)}`);
});

test('an item read prints a start waiting for capacity with the id that withdraws it', () => {
  const lines = itemReadLines(read);
  const section = lines.slice(lines.indexOf('Waiting to start:') + 1, lines.indexOf('Links:'));
  expect(section).toHaveLength(2);
  expect(section[0]).toContain('b6f1c2d4-0000-4000-8000-000000000001');
  expect(section[0]).toContain('build');
  expect(section[0]).toContain('12 ahead on host host');
  // The host that must drain the start shows when it is next, too.
  const next = itemReadLines({
    ...read,
    queued: read.queued.map(start => ({ ...start, ahead: 0 })),
  });
  expect(next.find(line => line.includes('b6f1c2d4'))).toContain('on host host');
  const empty = itemReadLines({ ...read, queued: [] });
  expect(empty[empty.indexOf('Waiting to start:') + 1]).toBe('  none');
});

test('an item read prints each link with the other item, kind and direction', () => {
  const lines = itemReadLines(read);
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
  const text = itemReadLines({
    ...read,
    runs: read.runs.map(run => ({ ...run, id: 'run-truncated', hasResult: false })),
  }).join('\n');
  expect(text).toContain('result: holds at a1b2c3d4e5f6');
  expect(text).not.toContain('archon workflow get run-truncated');
});
