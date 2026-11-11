import { expect, test } from 'bun:test';
import {
  attentionWatchReader,
  type AttentionNeeds,
  type AttentionWatchLevel,
  type ClassifiedAttentionStreamLine,
} from './attention-needs';
import type { AttentionStreamLine } from './attention-watch';
import { workflowEventCursor } from './store';

test('every line type has a needs, and each level shows its lines and the close of an item it showed', () => {
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
  // One stream in order: a usage-limit wait nobody was shown opens and closes, then an ask
  // opens and closes, then an unreadable item is replaced by a usage-limit wait. The
  // third field marks a close of a shown item: nothing to do, and every level shows it.
  const stream: [AttentionStreamLine, AttentionNeeds, 'close'?][] = [
    [{ type: 'ready', cursor }, 'nothing'],
    [{ type: 'bookmark', cursor }, 'nothing'],
    [limited, 'nothing'],
    [resolved, 'nothing'],
    [opened, 'answer'],
    [resolved, 'nothing', 'close'],
    [opened, 'answer'],
    [{ type: 'unmatched', ...run, occurrence: 'o', revision: 2 }, 'nothing', 'close'],
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
  const all = stream.map(([line, needs]) => ({ ...line, needs }));
  const shown = (level: AttentionWatchLevel): ClassifiedAttentionStreamLine[] => {
    const read = attentionWatchReader(level);
    return stream.flatMap(([line]) => read(line) ?? []);
  };
  expect(shown('protocol')).toEqual(all);
  expect(shown('quiet')).toEqual(
    all.filter((line, index) => line.needs !== 'nothing' || stream[index]?.[2] === 'close')
  );
  expect(shown('notices')).toEqual(
    all.filter(line => line.type !== 'ready' && line.type !== 'bookmark')
  );

  // A stream resumed from a cursor did not see what the earlier one showed.
  expect(attentionWatchReader('quiet', { resumed: true })(resolved)).toEqual({
    ...resolved,
    needs: 'nothing',
  });
  expect(attentionWatchReader('quiet')(resolved)).toBeUndefined();
});
