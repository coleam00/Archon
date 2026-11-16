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
    },
  ],
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

test('an item read prints its active links with direction, then the ended ones', () => {
  const lines = itemReadLines(read);
  const links = lines.slice(lines.indexOf('Links:') + 1, lines.indexOf('Open questions:') - 1);
  expect(links).toEqual([
    // Another project's item is named with its project.
    '  link-out  this item depends_on → acme/api/issue-3',
    '  link-in  ← issue-9 duplicate_of this item',
    '  link-ended  this item part_of → order-1 (ended 2026-11-01T08:30Z by alice (self-declared), via cli)',
    '  1 link(s) of this item could not be read: link-lost',
  ]);
});
