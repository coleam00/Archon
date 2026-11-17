import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { StoredItemAsk } from '@archon/workflows/schemas/item-ask';
import { asksResultMetadata } from '@archon/workflows/schemas/run-metadata';
import { createAsksSettledStarts } from './asks-settled';

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

function trigger(inputs: Record<string, unknown>, cwd = PROJECT_CWD) {
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
    on: { asksSettled: { workflowName: 'plan', settled: 'answered', inputs } },
  };
}

async function prepareWith(files: Record<string, unknown>) {
  const directory = track(await mkdtemp(join(tmpdir(), 'archon-asks-settled-')));
  for (const [name, value] of Object.entries(files))
    await writeFile(
      join(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value)
    );
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
});
