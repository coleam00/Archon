import { NO_ITEM_ASKS, type ItemAsks } from '../components/ItemAsksSection';
import type { ItemAsk } from '../primitives/run';
import type { ItemRead } from '../skills/items';

/**
 * An item of pack `Wirasm.archon-software-factory` standing at its one run, of graph stage
 * `workflow` (or of no pack when null), in `state`; `asked` gives its read a question. Whether it
 * has open asks is the attention list's (`asksOn`), not this.
 */
export function itemOn(
  key: string,
  workflow: string | null,
  state: ItemRead['standing']['state'],
  asked = false
): ItemRead {
  return {
    item: { id: `id-${key}`, projectKey: 'acme/web', key, title: `Title of ${key}` },
    standing: {
      runId: `run-${key}`,
      state,
      pack: workflow === null ? null : 'Wirasm.archon-software-factory',
    },
    runs: [
      {
        id: `run-${key}`,
        workflow: workflow ?? 'by-hand',
        pack: workflow === null ? null : { key: 'Wirasm.archon-software-factory', workflow },
        status: state === 'running' ? 'running' : 'completed',
        outcome: null,
        startedAt: '2026-11-20T10:00:00.000Z',
        completedAt: null,
        cause: null,
        awaitingExecution: null,
        startLimit: null,
        spend: { usd: null, inputTokens: null, outputTokens: null },
        heldBehind: null,
        operatorPause: null,
        hasResult: false,
        resultCommit: null,
        changeSize: null,
      },
    ],
    queued: [],
    skipped: [],
    hold: null,
    held: [],
    runLimit: null,
    startLimits: [],
    waits: [],
    questions: asked
      ? ([{ kind: 'ask', id: `ask-${key}` }] as unknown as ItemRead['questions'])
      : [],
    answers: [],
    links: [],
    merged: null,
    landing: null,
    priority: null,
    ended: null,
    workOrder: null,
    dependsOn: [],
    degraded: [],
  };
}

/** Items on the shipped pack's stages: two on build (one asking), one on each check stage, one off the map. */
export const MOVING_ITEMS: ItemRead[] = [
  itemOn('b1', 'stage-build', 'running'),
  itemOn('b2', 'stage-build', 'waiting', true),
  itemOn('c1', 'stage-check', 'running'),
  itemOn('h1', 'stage-host', 'queued'),
  itemOn('t1', 'triage', 'waiting'),
  itemOn('s1', 'split', 'waiting'),
  itemOn('g1', 'landgate', 'waiting', true),
  itemOn('d1', 'discoveries', 'running'),
];

/** One open attention ask on `read`, as the attention list returns it. */
export function askOn(read: ItemRead, ref = `ask:${read.item.key}`): ItemAsk {
  return {
    kind: 'attention',
    ref,
    project: { key: 'acme/web', codebaseId: 'web', name: 'web' },
    item: { id: read.item.id, projectKey: read.item.projectKey, key: read.item.key },
    priority: false,
    revision: 1,
    labels: {},
    pausedAt: null,
    message: 'Land it?',
    form: 'select',
    options: [{ id: 'land', does: 'Lands it.', cost: 'Nothing.' }],
  };
}

/** The project's asks: one open ask on each of `reads`. */
export function asksOn(reads: readonly ItemRead[]): ItemAsks {
  return { ...NO_ITEM_ASKS, asks: reads.map(read => askOn(read)) };
}
