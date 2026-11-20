import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createStallMessenger, type StallMessengerOptions } from './stall-message';
import type { StreamStall } from './tool-call-attention';

const MINUTE = 60_000;
const track = trackTempRoots();

function harness(overrides: Partial<StallMessengerOptions> = {}) {
  let time = 100 * MINUTE;
  const logDir = track(mkdtempSync(join(tmpdir(), 'stall-message-')));
  const createWorkflowEvent = mock(async (_event: { data?: Record<string, unknown> }) => {});
  const messenger = createStallMessenger({
    store: { createWorkflowEvent },
    logDir,
    runId: 'run',
    stepName: 'ci',
    provider: 'claude',
    capabilities: { turnMessages: true },
    policy: { stallMessageLimit: 3, toolCallAttentionMs: 30 * MINUTE },
    now: () => time,
    ...overrides,
  });
  return {
    messenger,
    events: () => createWorkflowEvent.mock.calls.map(([event]) => event.data),
    transcript: (): unknown[] => {
      const path = join(logDir, 'run.jsonl');
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as unknown);
    },
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

const countsOf = (h: ReturnType<typeof harness>) => h.events().map(data => data?.count);

describe('stall messages', () => {
  test('a message is sent only once a threshold has passed since the last, up to the limit', async () => {
    const h = harness();
    const pass = h.messenger.openPass();
    await pass.check(undefined);
    expect(countsOf(h)).toEqual([]);
    await pass.check(stallOf(h));
    expect(countsOf(h)).toEqual([1]);
    h.advance(29 * MINUTE);
    await pass.check(stallOf(h));
    expect(countsOf(h)).toEqual([1]);
    h.advance(MINUTE);
    await pass.check(stallOf(h));
    expect(countsOf(h)).toEqual([1, 2]);
    h.advance(29 * MINUTE);
    await pass.check(stallOf(h));
    expect(countsOf(h)).toEqual([1, 2]);
    h.advance(MINUTE);
    await pass.check(stallOf(h));
    h.advance(60 * MINUTE);
    await pass.check(stallOf(h));
    expect(countsOf(h)).toEqual([1, 2, 3]);
    expect(await textsOf(pass)).toHaveLength(3);
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
    expect(h.events()).toEqual([]);
  });

  test('a provider that cannot take a message is recorded once per attempt, however long it stalls', async () => {
    const h = harness({ provider: 'pi', capabilities: {} });
    const first = h.messenger.openPass();
    expect(first.turnMessages).toBeUndefined();
    await first.check(stallOf(h));
    h.advance(60 * MINUTE);
    await first.check(stallOf(h));
    const second = h.messenger.openPass();
    await second.check(stallOf(h));
    expect(h.events()).toEqual([{ sent: false, reason: 'provider_unsupported', provider: 'pi' }]);
  });

  test('a refused message is recorded against the message it refused, in events and the transcript', async () => {
    const h = harness({ provider: 'codex' });
    const pass = h.messenger.openPass();
    await pass.check(stallOf(h));
    await pass.refused('no active turn to steer');
    const refusal = {
      sent: false,
      reason: 'provider_refused',
      provider: 'codex',
      count: 1,
      limit: 3,
      error: 'no active turn to steer',
    };
    expect(h.events()).toEqual([expect.objectContaining({ sent: true, count: 1 }), refusal]);
    expect(h.transcript()).toEqual([
      expect.objectContaining({
        type: 'stall_message',
        step: 'ci',
        stall_message: expect.objectContaining({ sent: true, sender: 'engine', count: 1 }),
      }),
      expect.objectContaining({ type: 'stall_message', step: 'ci', stall_message: refusal }),
    ]);
  });

  test('the text names the open work and how long it has shown no progress', async () => {
    const h = harness();
    const pass = h.messenger.openPass();
    await pass.check(stallOf(h, 5));
    const [text] = await textsOf(pass);
    expect(text).toContain('automatic message 1 of 3');
    expect(text).toContain('no progress has been reported for 31 minutes');
    expect(text).toContain('- tool call Bash ("bun test"), open for 34 minutes');
    expect(text).toContain('- background task local_bash ("watcher 1"), open for 34 minutes');
    expect(text).not.toContain('watcher 3');
    expect(text).toContain('- and 2 more');
  });
});
