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
  ],
  degraded: [],
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
});
