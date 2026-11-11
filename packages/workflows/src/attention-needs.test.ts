import { expect, test } from 'bun:test';
import {
  attentionLineClassifier,
  attentionWatchLevelPasses,
  type AttentionNeeds,
  type AttentionWatchLevel,
  type ClassifiedAttentionStreamLine,
} from './attention-needs';
import type { AttentionStreamLine } from './attention-watch';
import { workflowEventCursor } from './store';

test('every line type has a needs, and each watch level passes its lines', () => {
  const cursor = workflowEventCursor('c');
  const run = { cursor, project: null, runId: 'r', workflow: 'ci', parentRunId: null };
  const terminal = { type: 'terminal', ...run, outcome: null, cause: null } as const;
  const resolved = { type: 'resolved', ...run, occurrence: 'o', reason: 'withdrawn' } as const;
  const item = {
    runId: 'r',
    workflow: 'ci',
    project: null,
    parentRunId: null,
    fanOut: null,
    revision: 1,
    labels: {},
    pausedAt: null,
    context: { artifactsDir: null, transcript: null, workingPath: null, branch: null },
    node: 'ask',
  };
  const opened: AttentionStreamLine = {
    type: 'attention',
    cursor,
    snapshot: false,
    project: null,
    workflow: 'ci',
    parentRunId: null,
    item: {
      ...item,
      kind: 'attention',
      occurrence: 'o',
      message: 'Go?',
      form: 'message',
      options: [],
    },
  };
  const limited: AttentionStreamLine = {
    ...opened,
    item: { ...item, kind: 'usage_limit', resetAt: '2026-01-01T00:00:00.000Z' },
  };
  const unreadable: AttentionStreamLine = {
    ...opened,
    item: { ...item, kind: 'unreadable', reason: 'malformed_gate', detail: 'd' },
  };
  // One stream in order: a usage-limit wait nobody held opens and closes, then an ask
  // opens and closes, then an unreadable item is replaced by a usage-limit wait.
  const stream: [AttentionStreamLine, AttentionNeeds][] = [
    [{ type: 'ready', cursor }, 'nothing'],
    [{ type: 'bookmark', cursor }, 'nothing'],
    [limited, 'nothing'],
    [resolved, 'nothing'],
    [opened, 'answer'],
    [resolved, 'look'],
    [unreadable, 'look'],
    [limited, 'look'],
    [{ type: 'unmatched', ...run, occurrence: 'o', revision: 2 }, 'nothing'],
    [{ type: 'resumed', ...run, status: 'running' }, 'nothing'],
    [{ ...terminal, status: 'completed' }, 'nothing'],
    [{ ...terminal, status: 'cancelled' }, 'nothing'],
    [{ ...terminal, status: 'failed' }, 'look'],
    [{ ...terminal, status: 'completed', outcome: 'failed' }, 'look'],
    [{ type: 'owner_lost', ...run, observedStatus: 'running' }, 'look'],
    [{ type: 'degraded', reason: 'run_unreadable', cursor }, 'look'],
    [{ type: 'error', error: 'cursor_invalid' }, 'look'],
  ];
  const classify = attentionLineClassifier();
  const classified = stream.map(([line]) => classify(line));
  expect(classified).toEqual(stream.map(([line, needs]) => ({ ...line, needs })));

  const passed = (level: AttentionWatchLevel): ClassifiedAttentionStreamLine[] =>
    classified.filter(line => attentionWatchLevelPasses(level, line));
  expect(passed('quiet')).toEqual(classified.filter(line => line.needs !== 'nothing'));
  expect(passed('notices')).toEqual(
    classified.filter(line => line.type !== 'ready' && line.type !== 'bookmark')
  );
  expect(passed('protocol')).toEqual(classified);

  // A stream resumed from a cursor did not see what the earlier one held.
  expect(attentionLineClassifier({ resumed: true })(resolved).needs).toBe('look');
});
