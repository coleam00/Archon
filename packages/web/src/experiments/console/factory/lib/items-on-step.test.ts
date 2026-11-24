import { describe, expect, test } from 'bun:test';
import { capturedItemAs, capturedItemsPage } from './fixtures/factory-items-page';
import { itemsOnStep, runningItems } from './items-on-step';

const captured = capturedItemsPage.items;
const running = (step: string | null, workflow = 'deliver') => ({
  running: { runId: `run-${String(step)}`, workflow, step, startedAt: '2026-11-17T07:00:00.000Z' },
});
const items = [
  ...captured,
  capturedItemAs('loop', running('rounds')),
  capturedItemAs('between', running(null)),
  capturedItemAs('triaged', running('classify', 'triage')),
  capturedItemAs('unread', null),
];
const keys = (list: { item: { item: { key: string } } }[] | undefined): string[] =>
  (list ?? []).map(({ item }) => item.item.key);

describe('itemsOnStep', () => {
  test('lists the items on each step in read order; a run between loop bodies by the loop id', () => {
    const onStep = itemsOnStep(items, 'deliver');
    expect(keys(onStep.get('build__build'))).toEqual(['12', '4', '6']);
    expect(keys(onStep.get('rounds'))).toEqual(['loop']);
    // No step for a run between steps, an idle item or an item with no progress.
    expect([...onStep.keys()].sort()).toEqual(['build__build', 'rounds']);
  });

  test('keeps to the asked workflow', () => {
    expect(keys(itemsOnStep(items, 'triage').get('classify'))).toEqual(['triaged']);
    expect(itemsOnStep(items, 'deliver').has('classify')).toBe(false);
  });
});

describe('runningItems', () => {
  test("includes a run between steps and leaves out idle items and other workflows' runs", () => {
    expect(keys(runningItems(items, 'deliver'))).toEqual(['12', '4', '6', 'loop', 'between']);
  });
});
