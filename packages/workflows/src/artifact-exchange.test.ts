import { describe, expect, test } from 'bun:test';
import { ArtifactExchangeError, withArtifactExchange } from './artifact-exchange';

function exchange(events: string[], failures: { publish?: Error; collect?: Error } = {}) {
  return {
    async publish() {
      events.push('publish');
      if (failures.publish) throw failures.publish;
    },
    async collect() {
      events.push('collect');
      if (failures.collect) throw failures.collect;
    },
  };
}

describe('withArtifactExchange', () => {
  test('leaves host execution unchanged', async () => {
    expect(await withArtifactExchange(undefined, async () => 42)).toBe(42);
    const failure = new Error('invocation');
    await expect(
      withArtifactExchange(undefined, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  test('publishes before invocation and collects before returning its value', async () => {
    const events: string[] = [];
    const value = await withArtifactExchange(exchange(events), async () => {
      events.push('invoke');
      return 'output';
    });
    expect(value).toBe('output');
    expect(events).toEqual(['publish', 'invoke', 'collect']);
  });

  test.each(['failure', 'cancellation'])('collects on invocation %s', async reason => {
    const events: string[] = [];
    const failure = new Error(reason);
    await expect(
      withArtifactExchange(exchange(events), async () => {
        events.push('invoke');
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(events).toEqual(['publish', 'invoke', 'collect']);
  });

  test('does not invoke after a publication refusal', async () => {
    const events: string[] = [];
    const failure = new Error('refused');
    try {
      await withArtifactExchange(exchange(events, { publish: failure }), async () =>
        events.push('invoke')
      );
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactExchangeError);
      expect((error as Error).cause).toBe(failure);
    }
    expect(events).toEqual(['publish']);
  });

  test('surfaces collection failure after success', async () => {
    const failure = new Error('collection');
    await expect(
      withArtifactExchange(exchange([], { collect: failure }), async () => 'output')
    ).rejects.toBeInstanceOf(ArtifactExchangeError);
  });

  test('preserves invocation and collection failures together', async () => {
    const invocation = new Error('invocation');
    const collection = new Error('collection');
    try {
      await withArtifactExchange(exchange([], { collect: collection }), async () => {
        throw invocation;
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactExchangeError);
      const cause = (error as Error).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors).toEqual([invocation, collection]);
    }
  });
});
