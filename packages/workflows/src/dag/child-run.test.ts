import { describe, expect, it } from 'bun:test';
import { childOutcomeFromRun, readChildOutcome } from './child-run';
import type { WorkflowRun } from '../schemas';
import { foldDagResumeSnapshot } from '../dag-resume-snapshot';

function settledRun(metadata: Record<string, unknown>): WorkflowRun {
  return {
    origin: { conversationId: 'conv-child' },
    id: 'child-1',
    workflow_name: 'child',
    conversation_id: 'conv-child',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'completed',
    outcome: null,
    user_message: 'child input',
    metadata,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    adopted_from_run_id: null,
  };
}

describe('childOutcomeFromRun cache reporting', () => {
  it('carries a child run total that is only a floor up to its parent', () => {
    const outcome = childOutcomeFromRun(
      settledRun({
        total_tokens_in: 100,
        total_tokens_out: 10,
        total_cache_read_tokens: 60,
        total_cache_write_tokens: 0,
        total_cache_partial: true,
      })
    );

    // Reading the numbers but not the flag let a parent merge a child's floor as
    // though it were exact, which is the same defect one run boundary up.
    expect(outcome.tokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 60,
      cacheWrite: 0,
      cachePartial: true,
    });
  });

  it.each([true, null, 'false', 0, undefined, {}, []].map(marker => ({ marker })))(
    'keeps a present unknown marker unavailable despite numeric metadata: %j',
    ({ marker }) => {
      const outcome = childOutcomeFromRun(
        settledRun({
          total_tokens_unknown: marker,
          total_tokens_in: 170,
          total_tokens_out: 20,
          total_cost_usd: 0.3,
        })
      );
      expect(outcome.tokens).toBeUndefined();
      expect(outcome.tokensUnknown).toBe(true);
      expect(outcome.costUsd).toBe(0.3);
    }
  );

  it('leaves a complete child total unflagged', () => {
    const outcome = childOutcomeFromRun(
      settledRun({
        total_tokens_in: 100,
        total_tokens_out: 10,
        total_cache_read_tokens: 60,
        total_cache_write_tokens: 0,
      })
    );

    expect(outcome.tokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 60,
      cacheWrite: 0,
    });
    // toEqual alone would still pass on `cachePartial: undefined`; the key must be absent,
    // because absence is what every reader treats as "this total is exact".
    expect(outcome.tokens).not.toHaveProperty('cachePartial');
  });
});

describe('childOutcomeFromRun historical required counters', () => {
  it.each([
    { total_tokens_in: 100 },
    { total_tokens_out: 10 },
    { total_tokens_in: 100, total_tokens_out: 'unreadable' },
    { total_tokens_in: 'unreadable', total_tokens_out: 10 },
    { total_tokens_in: null, total_tokens_out: null },
    { total_tokens_in: NaN, total_tokens_out: 10 },
    { total_tokens_in: 100, total_tokens_out: Infinity },
  ])('keeps malformed counters unknown: %j', metadata => {
    const outcome = childOutcomeFromRun(settledRun({ ...metadata, total_cost_usd: 0.3 }));
    expect(outcome.tokensUnknown).toBe(true);
    expect(outcome.tokens).toBeUndefined();
    expect(outcome.costUsd).toBe(0.3);
    expect(outcome.status).toBe('completed');
  });

  it('preserves absent usage and valid zero totals', () => {
    const absent = childOutcomeFromRun(settledRun({}));
    expect(absent.tokens).toBeUndefined();
    expect(absent.tokensUnknown).toBeUndefined();
    const zero = childOutcomeFromRun(
      settledRun({ total_tokens_in: 0, total_tokens_out: 0, total_tokens_unknown: false })
    );
    expect(zero.tokens).toEqual({ input: 0, output: 0 });
    expect(zero.tokensUnknown).toBeUndefined();
  });
});

for (const status of [
  'completed',
  'failed',
  'cancelled',
  'paused',
  'running',
  'pending',
] as const) {
  for (const marker of [undefined, true]) {
    it.each([undefined, null, 'invalid', NaN, Infinity, 0, 0.3])(
      `recovers the child floor for ${status}, marker ${String(marker)}, row cost %j`,
      async cost => {
        const outcome = await readChildOutcome(
          {
            getDagResumeSnapshot: async id =>
              foldDagResumeSnapshot(
                [
                  {
                    step_name: 'priced',
                    event_type: 'node_completed',
                    data: { type: 'agent', cost_usd: 0.2 },
                  },
                ],
                id
              ),
          },
          { ...settledRun({ total_cost_usd: cost, total_cost_incomplete: marker }), status }
        );
        expect(outcome.costUsd).toBe(
          status !== 'paused' &&
            status !== 'running' &&
            status !== 'pending' &&
            typeof cost === 'number' &&
            Number.isFinite(cost)
            ? cost
            : 0.2
        );
        expect(outcome.costIncomplete).toBe(marker);
      }
    );
  }
}

it.each(['completed', 'failed', 'cancelled', 'paused', 'running', 'pending'] as const)(
  'retains accepted metadata and lifecycle when %s child enrichment fails',
  async status => {
    const outcome = await readChildOutcome(
      {
        getDagResumeSnapshot: async () => {
          throw new Error('history unavailable');
        },
      },
      { ...settledRun({ total_cost_usd: 0.2, total_tokens_in: 10, total_tokens_out: 2 }), status }
    );
    expect(outcome).toMatchObject({
      status: status === 'running' || status === 'pending' ? 'paused' : status,
      costUsd: 0.2,
      costIncomplete: true,
    });
    const held = status === 'paused' || status === 'running' || status === 'pending';
    expect(outcome.tokensUnknown).toBe(held ? true : undefined);
    expect(outcome.tokens).toEqual(held ? undefined : { input: 10, output: 2 });
  }
);

it.each([false, true])('refreshes held child tokens (unknown: %s)', async unknown => {
  const outcome = await readChildOutcome(
    {
      getDagResumeSnapshot: id =>
        foldDagResumeSnapshot(
          [
            {
              step_name: 'new',
              event_type: 'node_completed',
              data: {
                type: 'agent',
                cost_usd: 0.3,
                ...(unknown
                  ? { tokens: { input: 'invalid', output: 6 } }
                  : { tokens: { input: 30, output: 6, cacheRead: 5, cacheWrite: 0 } }),
              },
            },
          ],
          id
        ),
    },
    {
      ...settledRun({ total_cost_usd: 0.2, total_tokens_in: 10, total_tokens_out: 2 }),
      status: 'paused',
    }
  );
  expect(outcome.costUsd).toBe(0.3);
  expect(outcome.tokensUnknown).toBe(unknown ? true : undefined);
  expect(outcome.tokens).toEqual(
    unknown ? undefined : { input: 30, output: 6, cacheRead: 5, cacheWrite: 0 }
  );
});
