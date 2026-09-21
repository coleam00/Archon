/**
 * `buildNodeSummaries` projects a run's event log into the per-node view that
 * `archon workflow get/status --verbose` renders, and the `nodes` array their
 * `--json` form emits.
 *
 * `.spec.ts` rather than `.test.ts`: `packages/cli/tsconfig.json` excludes
 * `**\/*.test.ts` and the root ESLint config ignores it, so a `.test.ts` here
 * would be neither type-checked nor linted.
 */
import { describe, expect, it } from 'bun:test';
import type { WorkflowEventRow } from '@archon/core/db/workflow-events';
import { buildNodeSummaries } from './workflow';

function event(
  id: string,
  eventType: WorkflowEventRow['event_type'],
  stepName: string,
  createdAt: string,
  data: Record<string, unknown> = {}
): WorkflowEventRow {
  return {
    id,
    workflow_run_id: 'run-prior-success',
    event_type: eventType,
    step_name: stepName,
    step_index: 0,
    data,
    created_at: createdAt,
  };
}

describe('buildNodeSummaries', () => {
  it('resets a retried node to its current running attempt', () => {
    const summaries = buildNodeSummaries([
      {
        id: 'retry-start-1',
        workflow_run_id: 'run-retry',
        event_type: 'node_started',
        step_index: 0,
        step_name: 'build',
        data: {},
        created_at: '2026-08-03T10:00:00.000Z',
        event_order: 1,
      },
      {
        id: 'retry-failed',
        workflow_run_id: 'run-retry',
        event_type: 'node_failed',
        step_index: 0,
        step_name: 'build',
        data: { error: 'temporary failure' },
        created_at: '2026-08-03T10:00:01.000Z',
        event_order: 2,
      },
      {
        id: 'retry-start-2',
        workflow_run_id: 'run-retry',
        event_type: 'node_started',
        step_index: 0,
        step_name: 'build',
        data: {},
        created_at: '2026-08-03T10:00:02.000Z',
        event_order: 3,
      },
    ]);

    expect(summaries).toEqual([
      { nodeId: 'build', state: 'running', startedAt: '2026-08-03T10:00:02.000Z' },
    ]);
  });

  // #2973: the engine re-emits node_skipped_prior_success on every resume pass,
  // including its own durable-wait continuation. Folding it into `skipped` made
  // `archon workflow get` report the node that opened a PR as never having run.
  it('keeps a completed node completed across repeated resume replays', () => {
    // The engine copies the prior output forward, so a real replay repeats the
    // original text. These replays carry a DIFFERENT string on purpose: matching
    // text would pass whether the projection kept the original summary or
    // overwrote it with an equal value, and only the first is the contract.
    const summaries = buildNodeSummaries([
      event('pr-started', 'node_started', 'deliver__pr__pr', '2026-08-29T14:27:29.000Z'),
      event('pr-completed', 'node_completed', 'deliver__pr__pr', '2026-08-29T14:29:16.000Z', {
        node_output: 'https://github.com/coleam00/Archon/pull/2971',
      }),
      event(
        'pr-replay-1',
        'node_skipped_prior_success',
        'deliver__pr__pr',
        '2026-08-29T14:53:47.000Z',
        {
          reason: 'prior_success',
          node_output: 'replay 1 output',
        }
      ),
      event(
        'pr-replay-2',
        'node_skipped_prior_success',
        'deliver__pr__pr',
        '2026-08-29T15:38:50.000Z',
        {
          reason: 'prior_success',
          node_output: 'replay 2 output',
        }
      ),
    ]);

    expect(summaries).toEqual([
      {
        nodeId: 'deliver__pr__pr',
        state: 'completed',
        startedAt: '2026-08-29T14:27:29.000Z',
        durationMs: 107_000,
        outputPreview: 'https://github.com/coleam00/Archon/pull/2971',
      },
    ]);
  });

  it('reports a genuinely skipped node as skipped', () => {
    const summaries = buildNodeSummaries([
      event('gate-skipped', 'node_skipped', 'deliver__gate-green', '2026-08-29T14:30:00.000Z', {
        reason: 'trigger_rule',
        cause: { kind: 'upstream_failed', origin: 'deliver__validate' },
      }),
    ]);

    expect(summaries).toEqual([
      {
        nodeId: 'deliver__gate-green',
        state: 'skipped',
        cause: { kind: 'upstream_failed', origin: 'deliver__validate' },
      },
    ]);
  });

  it('retains a timeout skip cause', () => {
    const summaries = buildNodeSummaries([
      event('timeout-skip', 'node_skipped', 'ci-note', '2026-08-29T14:30:00.000Z', {
        reason: 'timeout',
        cause: { kind: 'timeout' },
      }),
    ]);

    expect(summaries).toEqual([
      {
        nodeId: 'ci-note',
        state: 'skipped',
        cause: { kind: 'timeout' },
      },
    ]);
  });

  it('keeps legacy skipped rows without a cause readable', () => {
    const summaries = buildNodeSummaries([
      event('legacy-skip', 'node_skipped', 'legacy', '2026-08-29T14:30:00.000Z', {
        reason: 'trigger_rule',
      }),
    ]);

    expect(summaries).toEqual([{ nodeId: 'legacy', state: 'skipped' }]);
  });

  it('reports a prior-success replay as completed when the original completion is absent', () => {
    const summaries = buildNodeSummaries([
      event(
        'lone-replay',
        'node_skipped_prior_success',
        'triage__triage',
        '2026-08-29T14:53:47.000Z',
        {
          reason: 'prior_success',
          node_output: 'bug',
        }
      ),
    ]);

    expect(summaries).toEqual([
      { nodeId: 'triage__triage', state: 'completed', outputPreview: 'bug' },
    ]);
  });
});

// #3271: SQLite writes `created_at` as `datetime('now')` — UTC, "YYYY-MM-DD HH:MM:SS",
// no zone marker — and `new Date()` reads a marker-less string as LOCAL time. A
// constant UTC offset cancels out of `end - start`, so the defect only shows when
// the offset changes between the two events: across a DST transition the local
// reading skips or repeats an hour and the duration is off by that hour.
describe('buildNodeSummaries durations', () => {
  // 01:30 → 03:30 UTC on 2026-03-08 is two hours. Read as America/New_York local
  // time, the 02:00 → 03:00 hour does not exist that morning, so the naive parse
  // yields one hour. UTC and Asia/Kolkata (no DST) are the controls.
  const SQLITE_DST_INTERVAL = [
    event('dst-start', 'node_started', 'build', '2026-03-08 01:30:00'),
    event('dst-end', 'node_completed', 'build', '2026-03-08 03:30:00'),
  ];

  function withTimezone<T>(tz: string, fn: () => T): T {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }

  it.each(['America/New_York', 'UTC', 'Asia/Kolkata'])(
    'measures a SQLite interval across a DST boundary as two hours under %s',
    tz => {
      const [summary] = withTimezone(tz, () => buildNodeSummaries(SQLITE_DST_INTERVAL));
      expect(summary?.durationMs).toBe(7_200_000);
    }
  );

  it('measures a failed node the same way as a completed one', () => {
    const [summary] = withTimezone('America/New_York', () =>
      buildNodeSummaries([
        event('fail-start', 'node_started', 'build', '2026-03-08 01:30:00'),
        event('fail-end', 'node_failed', 'build', '2026-03-08 03:30:00', { error: 'boom' }),
      ])
    );
    expect(summary?.durationMs).toBe(7_200_000);
  });

  it('trusts timestamps that already carry a zone marker', () => {
    // PostgreSQL and other paths hand over zoned strings; a `+05:30` and a `Z`
    // naming instants two hours apart must still measure two hours.
    const [summary] = withTimezone('America/New_York', () =>
      buildNodeSummaries([
        event('zoned-start', 'node_started', 'build', '2026-03-08T07:00:00+05:30'),
        event('zoned-end', 'node_completed', 'build', '2026-03-08T03:30:00.000Z'),
      ])
    );
    expect(summary?.durationMs).toBe(7_200_000);
  });
});
