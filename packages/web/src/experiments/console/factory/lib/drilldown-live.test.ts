import { describe, expect, test } from 'bun:test';
import { drilldownLive, type FactoryDrilldown } from './drilldown-live';
import { checksDrilldown } from './fixtures/checks-drilldown';
import { capturedItemAs } from './fixtures/factory-items-page';
import type { ItemOnStep } from './items-on-step';

const on = (key: string, step: string | null, workflow = 'deliver') =>
  capturedItemAs(key, {
    running: { runId: `run-${key}`, workflow, step, startedAt: '2026-11-17T07:00:00.000Z' },
  });
const keys = (list: readonly ItemOnStep[] | undefined): string[] =>
  (list ?? []).map(({ item }) => item.item.key);
/** Every lit card as `phase.card: keys`, so a test sees what lit and what did not. */
const lit = (live: ReturnType<typeof drilldownLive>): Record<string, string[]> =>
  Object.fromEntries(
    live.cards.flatMap((phase, p) =>
      phase.flatMap((card, c) => (card.length === 0 ? [] : [[`${p}.${c}`, keys(card)]]))
    )
  );

describe('drilldownLive', () => {
  test('an item on a covered step lights only the card covering it', () => {
    const live = drilldownLive(checksDrilldown, [on('7', 'rounds.review__review')]);
    expect(lit(live)).toEqual({ '1.0': ['7'] });
    expect(live.loop).toEqual([]);
  });

  test('a run between rounds lights the loop and no card', () => {
    const live = drilldownLive(checksDrilldown, [on('7', 'rounds')]);
    expect(lit(live)).toEqual({});
    expect(keys(live.loop)).toEqual(['7']);
  });

  test("a step another stage's drill-down covers, or no step, lights nothing", () => {
    const live = drilldownLive(checksDrilldown, [
      on('build', 'build__build'),
      on('between', null),
      on('idle', 'rounds.review__review', 'triage'),
    ]);
    expect(lit(live)).toEqual({});
    expect(live.loop).toEqual([]);
  });

  test('a card on each of two workflows lights for its own workflow', () => {
    const ready: FactoryDrilldown = {
      phases: [
        {
          label: 'Ready',
          cards: [
            { ...checksDrilldown.phases[0]!.cards[0]!, covers: [{ workflow: 'a', steps: ['go'] }] },
            { ...checksDrilldown.phases[0]!.cards[0]!, covers: [{ workflow: 'b', steps: ['go'] }] },
          ],
        },
      ],
    };
    const live = drilldownLive(ready, [on('1', 'go', 'b'), on('2', 'go', 'a'), on('3', 'go', 'b')]);
    expect(lit(live)).toEqual({ '0.0': ['2'], '0.1': ['1', '3'] });
  });
});
