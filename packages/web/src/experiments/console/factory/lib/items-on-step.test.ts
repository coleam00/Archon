import { describe, expect, test } from 'bun:test';
import type { FactoryWorkflow } from '../../skills/factory';
import deliverJson from './fixtures/deliver-workflow.json';
import { capturedItemAs, capturedItemsPage } from './fixtures/factory-items-page';
import { itemsOnStep, runningItems } from './items-on-step';
import { stepGraph } from './step-graph';

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
  test('lists every item whose run is on the step, in the read order', () => {
    expect(keys(itemsOnStep(items, 'deliver').get('build__build'))).toEqual(['12', '4', '6']);
  });

  test('keys a run between loop bodies by the loop id', () => {
    expect(keys(itemsOnStep(items, 'deliver').get('rounds'))).toEqual(['loop']);
  });

  test('holds no step for a run between steps, an idle item or an item with no progress', () => {
    expect([...itemsOnStep(items, 'deliver').keys()].sort()).toEqual(['build__build', 'rounds']);
  });

  test('keeps to the asked workflow', () => {
    expect(keys(itemsOnStep(items, 'triage').get('classify'))).toEqual(['triaged']);
    expect(itemsOnStep(items, 'deliver').has('classify')).toBe(false);
  });

  test("names only the deliver graph's step keys and loop ids for the captured runs", () => {
    const graph = stepGraph(
      deliverJson as FactoryWorkflow,
      () => ({ kind: 'none' }),
      key => key
    );
    const drawn = new Set([
      ...graph.nodes.map(node => node.key),
      ...graph.groups.filter(group => group.kind === 'loop').map(group => group.id),
    ]);
    for (const step of itemsOnStep(items, 'deliver').keys()) expect(drawn).toContain(step);
  });
});

describe('runningItems', () => {
  test("includes a run between steps and leaves out idle items and other workflows' runs", () => {
    expect(keys(runningItems(items, 'deliver'))).toEqual(['12', '4', '6', 'loop', 'between']);
  });
});
