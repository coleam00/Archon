import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import { asksCheckoutMetadata } from '@archon/workflows/schemas/resource-start';
import { asksResultMetadata } from '@archon/workflows/schemas/run-metadata';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { createAsksCheckout, createAsksSettledStarts } from './asks-settled';

const track = trackTempRoots();

const ITEM = { id: 'item-row', projectKey: 'acme/widgets', key: 'issue-7' };
const PROJECT_CWD = '/srv/widgets';
const RUN_ID = '9b2f6f0e-31a4-4d0c-8f0a-3f6c2f1b7a01';

function storedAsk(position: number, closed: StoredItemAsk['closed']): StoredItemAsk {
  return {
    id: `ask-${String(position)}`,
    itemId: ITEM.id,
    runId: RUN_ID,
    workflowName: 'plan',
    position,
    ask: {
      question: `Question ${String(position)}?`,
      context: 'Two readings.',
      options: [
        { id: 'keep', does: 'Keep it.', cost: 'More to maintain.' },
        { id: 'drop', does: 'Drop it.', cost: 'Configs break.' },
      ],
      recommendation: { option: 'keep', why: 'Nothing needs it gone.' },
      artifacts: [],
    },
    openedAt: '2026-11-16T09:00:00.000Z',
    closed,
  };
}

const act = { at: '2026-11-16T10:00:00.000Z', via: 'cli' as const, by: null, fromRun: null };
const SETTLED = [
  storedAsk(0, { as: 'answered', answer: { decision: 'keep', text: '' }, act }),
  storedAsk(1, { as: 'withdrawn', act }),
];

function trigger(
  inputs: Record<string, unknown>,
  cwd = PROJECT_CWD,
  extra: { checkout?: 'asking-run' } = {}
) {
  return {
    version: 1,
    sourceInstanceId: 'build-after-answers',
    binding: {
      bindingId: 'build',
      bindingRevision: null,
      hostId: 'factory-host',
      runAsUserId: 'operator',
      resource: 'build',
      overlap: 'queue',
      launch: { cwd, workflowName: 'build', inputs: {}, isolation: { kind: 'default' } },
    },
    on: { asksSettled: { workflowName: 'plan', settled: 'answered', inputs, ...extra } },
  };
}

async function triggersWith(files: Record<string, unknown>): Promise<string> {
  const directory = track(await mkdtemp(join(tmpdir(), 'archon-asks-settled-')));
  for (const [name, value] of Object.entries(files))
    await writeFile(
      join(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value)
    );
  return directory;
}

async function prepareWith(files: Record<string, unknown>) {
  const directory = await triggersWith(files);
  const prepare = createAsksSettledStarts({
    triggersDirectory: () => directory,
    getItem: async id => (id === ITEM.id ? ITEM : null),
    getItemAsk: async id => SETTLED.find(ask => ask.id === id) ?? null,
    projectKeyOf: async cwd => (cwd === PROJECT_CWD ? ITEM.projectKey : 'acme/other'),
    now: () => new Date('2026-11-16T10:00:00.000Z'),
  });
  return { directory, build: await prepare('ask-1') };
}

describe('asks-settled starts', () => {
  test('an input that cannot be read writes an unmatched receipt naming the file and input', async () => {
    const { directory, build } = await prepareWith({
      'build.json': trigger({ progress: { result: '/missing' } }),
    });
    const [receipt] = build?.(SETTLED, { metadata: asksResultMetadata({ summary: 'x' }) }) ?? [];
    expect(receipt).toMatchObject({
      outcome: 'unmatched',
      receipt: { deliveryId: RUN_ID, itemKey: ITEM.key },
    });
    expect(receipt?.reason).toContain(join(directory, 'build.json'));
    expect(receipt?.reason).toContain('progress');
  });

  test('when the asking run is gone, only a binding that reads nothing but the answers starts', async () => {
    const reads = await prepareWith({ 'build.json': trigger({ issue: { input: 'issue' } }) });
    expect(reads.build?.(SETTLED, null)).toMatchObject([
      { outcome: 'unmatched', reason: expect.stringContaining(`run '${RUN_ID}'`) },
    ]);
    const answersOnly = await prepareWith({
      'build.json': trigger({ decisions: { answers: true } }),
    });
    expect(answersOnly.build?.(SETTLED, null)).toMatchObject([
      {
        outcome: 'matched',
        bindings: [
          {
            eventInputs: {
              decisions: [
                { question: 'Question 0?', closedAs: 'answered', option: { id: 'keep' } },
                { question: 'Question 1?', closedAs: 'withdrawn', answer: null, option: null },
              ],
            },
          },
        ],
      },
    ]);
  });

  test('a binding that launches in another project starts nothing', async () => {
    const elsewhere = await prepareWith({
      'build.json': trigger({ decisions: { answers: true } }, '/srv/other'),
    });
    expect(elsewhere.build).toBeUndefined();
  });

  describe('with checkout: asking-run', () => {
    const takesCheckout = { 'build.json': trigger({}, PROJECT_CWD, { checkout: 'asking-run' }) };
    const commit = 'a'.repeat(40);

    test('hands on the checkout the asking run recorded when it ended', async () => {
      const { build } = await prepareWith(takesCheckout);
      const metadata = asksCheckoutMetadata({
        handoff: { runId: RUN_ID, branch: 'archon/plan-1', commit },
        worktree: tmpdir(),
      });
      expect(build?.(SETTLED, { metadata })).toMatchObject([
        {
          outcome: 'matched',
          bindings: [
            {
              checkoutFrom: { runId: RUN_ID, branch: 'archon/plan-1', commit },
              launch: { isolation: { kind: 'worktree', branch: 'archon/plan-1' } },
            },
          ],
        },
      ]);
    });

    test.each([
      [
        'a recorded refusal',
        { metadata: asksCheckoutMetadata({ refused: 'the worktree is gone' }) },
        'the worktree is gone',
      ],
      ['no record', { metadata: {} }, 'recorded no checkout'],
      ['a deleted asking run', null, 'no longer exists'],
    ] as const)('refuses the start naming why on %s', async (_, run, why) => {
      const { build } = await prepareWith(takesCheckout);
      const [receipt] = build?.(SETTLED, run) ?? [];
      expect(receipt).toMatchObject({ outcome: 'unmatched', bindings: [] });
      expect(receipt?.reason).toContain(`Checkout: `);
      expect(receipt?.reason).toContain(why);
    });

    test("the checkout is read at the asking run's completion only when such a binding matches", async () => {
      const run: WorkflowRun = {
        origin: { conversationId: 'conv-plan' },
        id: RUN_ID,
        workflow_name: 'plan',
        conversation_id: 'conv-plan',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'completed',
        outcome: null,
        completed_outcome: null,
        user_message: 'plan it',
        metadata: {},
        active_phase_started_at: null,
        started_at: new Date('2026-11-16T09:00:00.000Z'),
        completed_at: new Date('2026-11-16T09:30:00.000Z'),
        last_activity_at: null,
        working_path: null,
        user_id: null,
        parent_run_id: null,
        adopted_from_run_id: null,
        output_root: null,
        checkout_baseline: null,
        item_id: ITEM.id,
      };
      const readsFor = async (files: Record<string, unknown>) => {
        const directory = await triggersWith(files);
        const reads: string[] = [];
        const checkout = await createAsksCheckout({
          triggersDirectory: () => directory,
          getItem: async id => (id === ITEM.id ? ITEM : null),
          projectKeyOf: async cwd => (cwd === PROJECT_CWD ? ITEM.projectKey : 'acme/other'),
          getRun: async () => null,
          endedCheckout: async ended => {
            reads.push(ended.id);
            return { refused: 'read' };
          },
        })(run);
        return { checkout, reads };
      };
      expect(await readsFor(takesCheckout)).toEqual({
        checkout: { refused: 'read' },
        reads: [RUN_ID],
      });
      expect(await readsFor({ 'build.json': trigger({}) })).toEqual({
        checkout: undefined,
        reads: [],
      });
      expect(
        await readsFor({ 'build.json': trigger({}, '/srv/other', { checkout: 'asking-run' }) })
      ).toEqual({ checkout: undefined, reads: [] });
    });
  });
});
