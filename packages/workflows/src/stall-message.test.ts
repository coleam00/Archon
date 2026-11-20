import { describe, expect, mock, test } from 'bun:test';
import { createStallMessenger, type StallMessengerOptions } from './stall-message';
import type { StreamStall } from './tool-call-attention';

const MINUTE = 60_000;

function harness(overrides: Partial<StallMessengerOptions> = {}) {
  let time = 100 * MINUTE;
  const createWorkflowEvent = mock(async (_event: unknown) => {});
  const messenger = createStallMessenger({
    store: { createWorkflowEvent },
    runId: 'run',
    stepName: 'ci',
    provider: 'claude',
    capabilities: { turnMessages: true },
    policy: { stallMessageLimit: 2, toolCallAttentionMs: 30 * MINUTE },
    now: () => time,
    ...overrides,
  });
  return {
    messenger,
    createWorkflowEvent,
    advance: (ms: number) => {
      time += ms;
    },
    at: (minutesAgo: number) => new Date(time - minutesAgo * MINUTE).toISOString(),
  };
}

function stallOf(h: ReturnType<typeof harness>, calls = 1): StreamStall {
  return Array.from({ length: calls }, (_, index) => ({
    streamId: 'stream',
    toolCallId: index === 0 ? 'call' : `subtask:task-${String(index)}`,
    raisedAt: h.at(0),
    name: index === 0 ? 'Bash' : 'local_bash',
    title: index === 0 ? 'bun test' : `watcher ${String(index)}`,
    startedAt: h.at(34),
    lastProgressAt: h.at(31),
  }));
}

/** Every text the pass hands its session, once it is closed. */
async function textsOf(pass: { turnMessages: AsyncIterable<string> | undefined; close(): void }) {
  pass.close();
  return pass.turnMessages ? Array.fromAsync(pass.turnMessages) : [];
}

describe('stall messages', () => {
  test('one message per stall, spaced by the threshold, up to the limit', async () => {
    const h = harness();
    const pass = h.messenger.openPass();
    await pass.check(undefined);
    await pass.check(stallOf(h));
    h.advance(29 * MINUTE);
    await pass.check(stallOf(h));
    h.advance(MINUTE);
    await pass.check(stallOf(h));
    h.advance(60 * MINUTE);
    await pass.check(stallOf(h));
    const texts = await textsOf(pass);
    expect(texts).toHaveLength(2);
    expect(h.createWorkflowEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ sent: true, count: 1 }) }),
      expect.objectContaining({ data: expect.objectContaining({ sent: true, count: 2 }) }),
    ]);
  });

  test('the count spans the passes of one attempt', async () => {
    const h = harness({ policy: { stallMessageLimit: 1, toolCallAttentionMs: 30 * MINUTE } });
    const first = h.messenger.openPass();
    await first.check(stallOf(h));
    expect(await textsOf(first)).toHaveLength(1);
    const reask = h.messenger.openPass();
    h.advance(60 * MINUTE);
    await reask.check(stallOf(h));
    expect(await textsOf(reask)).toEqual([]);
  });

  test('a closed pass takes nothing and counts nothing', async () => {
    const h = harness({ policy: { stallMessageLimit: 1, toolCallAttentionMs: 30 * MINUTE } });
    const closed = h.messenger.openPass();
    closed.close();
    await closed.check(stallOf(h));
    const next = h.messenger.openPass();
    await next.check(stallOf(h));
    expect(await textsOf(next)).toHaveLength(1);
  });

  test('a limit of 0 sends and records nothing', async () => {
    const h = harness({ policy: { stallMessageLimit: 0, toolCallAttentionMs: 30 * MINUTE } });
    const pass = h.messenger.openPass();
    expect(pass.turnMessages).toBeUndefined();
    await pass.check(stallOf(h));
    expect(h.createWorkflowEvent).not.toHaveBeenCalled();
  });

  test('the text names the open work and how long it has shown no progress', async () => {
    const h = harness();
    const pass = h.messenger.openPass();
    await pass.check(stallOf(h, 5));
    const [text] = await textsOf(pass);
    expect(text).toBe(
      [
        'Archon engine check-in (automatic message 1 of 2): no progress has been reported for 31 minutes on this open work:',
        '- tool call Bash ("bun test"), open for 34 minutes',
        '- background task local_bash ("watcher 1"), open for 34 minutes',
        '- background task local_bash ("watcher 2"), open for 34 minutes',
        '- and 2 more',
        'This message carries no instruction about your work. If you are waiting on purpose, you can say so and keep waiting.',
      ].join('\n')
    );
  });
});
