import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import { durationWords } from './duration';
import { itemJourney, type Journey } from './item-journey';
import { itemColumn, placementInput } from './placement';

const NOW = Date.parse('2026-11-22T09:00:00Z');

const itinerary = (detail: FactoryItemDetail, column: ReturnType<typeof itemColumn>) =>
  itemJourney(shippedView, detail, column, NOW);

function journey(detail: FactoryItemDetail, now = NOW): Journey {
  const facts = new Map(detail.runs.map(run => [run.runId, run]));
  const column = itemColumn(shippedView, placementInput(detail.item, facts));
  return itemJourney(shippedView, detail, column, now);
}

const segment = (of: Journey, id: string) => {
  const found = of.segments.find(entry => entry.id === id);
  if (found === undefined) throw new Error(`no column ${id}`);
  return found;
};

describe('item 111: merged after one send-back', () => {
  const of = journey(itemDetail('111'));

  test("each column's time, which together are the time from order to merge", () => {
    expect(of.segments.map(entry => [entry.id, durationWords(entry.ms)])).toEqual([
      ['intake', '1 min'],
      ['plan-build', '39 min'],
      ['checks-review', '22 min'],
      ['ready', '3 min'],
      ['merged', '0 s'],
    ]);
    expect(of.segments.reduce((sum, entry) => sum + entry.ms, 0)).toBe(of.totalMs);
    const detail = itemDetail('111');
    const first = Date.parse(detail.item.runs[0]?.startedAt ?? '');
    const merged = Date.parse(detail.item.progress?.change?.mergedAt ?? '');
    expect(of.totalMs).toBe(merged - first);
    expect(of.until).toBe('merge');
  });

  test('the checks sent it back to Plan & build once; Merged is lit', () => {
    expect(segment(of, 'checks-review').loops).toEqual([{ to: 'Plan & build', count: 1 }]);
    expect(of.segments.filter(entry => entry.lit).map(entry => entry.id)).toEqual(['merged']);
    expect(of.segments.every(entry => entry.reached)).toBe(true);
  });
});

describe('item 113: an ask the build left', () => {
  test('a pause on Plan & build, from the asking run to the answer', () => {
    const detail = itemDetail('113');
    const asking = detail.item.runs.find(run => run.outcome === 'ask');
    const answer = detail.item.answers.find(entry => entry.kind === 'ask');
    const pauses = segment(journey(detail), 'plan-build').pauses;
    expect(pauses).toEqual([
      {
        ms: Date.parse(answer?.at ?? '') - Date.parse(asking?.completedAt ?? ''),
        open: false,
      },
    ]);
  });

  test('an open ask waits to now', () => {
    const detail = structuredClone(itemDetail('113'));
    const asking = detail.item.runs.find(run => run.outcome === 'ask');
    if (asking === undefined || asking.completedAt === null) throw new Error('113 asked');
    detail.item.answers = [];
    detail.item.questions = [
      {
        kind: 'attention',
        ref: 'ask:open',
        message: 'Which title?',
        askedIn: { runId: asking.id, workflow: asking.workflow },
      } as unknown as FactoryItemDetail['item']['questions'][number],
    ];
    expect(segment(journey(detail), 'plan-build').pauses).toEqual([
      { ms: NOW - Date.parse(asking.completedAt), open: true },
    ]);
  });
});

describe('item 86: parked by triage', () => {
  const of = journey(itemDetail('86'));

  test('it stops in Intake, saying so; nothing is lit, the rest not reached', () => {
    expect(segment(of, 'intake').stopped).toBe('Parked by triage');
    expect(of.segments.some(entry => entry.lit)).toBe(false);
    expect(of.segments.filter(entry => entry.reached).map(entry => entry.id)).toEqual(['intake']);
    // Its time ends where it stopped, not now.
    expect(of.until).toBe('stop');
    expect(of.totalMs).toBe(journey(itemDetail('86'), NOW + 3_600_000).totalMs);
  });
});

describe('item 125: the three-stage delivery', () => {
  test('four send-backs to Plan & build, and the restart at intake', () => {
    const of = journey(itemDetail('125'));
    expect(segment(of, 'checks-review').loops).toEqual([{ to: 'Plan & build', count: 4 }]);
    expect(segment(of, 'plan-build').loops).toEqual([{ to: 'Intake', count: 1 }]);
    expect(of.segments.reduce((sum, entry) => sum + entry.ms, 0)).toBe(of.totalMs);
  });
});

describe('an item whose last stage run failed', () => {
  test('stops there, even when a discoveries drain ran after it', () => {
    const detail = structuredClone(itemDetail('113'));
    const deliver = detail.item.runs.find(run => run.id.startsWith('2fd6990d'));
    if (deliver === undefined || detail.item.progress === null) throw new Error('113 delivered');
    const drain = detail.item.runs.find(run => run.workflow.endsWith(':discoveries'));
    if (drain === undefined) throw new Error('113 drained');
    deliver.status = 'failed';
    deliver.outcome = null;
    // The drain is the item's last run; the landgate after it never started.
    detail.item.runs = detail.item.runs.slice(0, detail.item.runs.indexOf(drain) + 1);
    detail.item.progress = { ...detail.item.progress, change: null, running: null };
    const of = journey(detail);
    expect(of.until).toBe('stop');
    expect(of.segments.find(entry => entry.stopped !== null)?.stopped).toBe('Failed');
    expect(of.totalMs).toBe(
      Date.parse(deliver.completedAt ?? '') - Date.parse(detail.item.runs[0]?.startedAt ?? '')
    );
  });
});

describe('an item that stopped by the view or by your answer', () => {
  test("ended by a declared ending: it stops where it was, in the ending's words", () => {
    const detail = structuredClone(itemDetail('86'));
    const triage = detail.item.runs.at(-1);
    if (triage === undefined || detail.item.progress === null) throw new Error('86 triaged');
    triage.outcome = 'close';
    detail.item.progress = { ...detail.item.progress, parked: null };
    const of = journey(detail);
    expect(segment(of, 'intake').stopped).toBe('Closed by triage');
    expect([of.stopped, of.until]).toEqual(['Closed by triage', 'stop']);
    expect(of.segments.some(entry => entry.lit)).toBe(false);
  });

  test('resting: every ask answered, nothing started, nothing running; it stops there', () => {
    // Item 3: two deliveries that asked, each answered, and nothing started after the last.
    const of = journey(itemDetail('3'));
    expect([of.stopped, of.until]).toEqual(['Nothing started after your answer', 'stop']);
    expect(of.segments.some(entry => entry.lit)).toBe(false);
    expect(of.segments.find(entry => entry.stopped !== null)?.id).toBe('plan-build');
  });

  test('a resting item whose change then merged ends merged', () => {
    const detail = structuredClone(itemDetail('3'));
    const change = detail.item.progress?.change;
    if (detail.item.progress === null || change == null) throw new Error('3 has a change');
    detail.item.progress = {
      ...detail.item.progress,
      change: { ...change, merged: true, mergedAt: '2026-11-17T06:00:00Z' },
    };
    const facts = new Map(detail.runs.map(run => [run.runId, run]));
    const column = itemColumn(shippedView, { ...placementInput(detail.item, facts), merged: true });
    const of = itinerary(detail, column);
    expect([of.stopped, of.until]).toEqual([null, 'merge']);
    expect(of.segments.filter(entry => entry.lit).map(entry => entry.id)).toEqual(['merged']);
  });

  test('not resting while the answer has started a run, or an ask is still open', () => {
    // Item 113, unmerged, between the run its answer started and the next: in flight.
    const between = structuredClone(itemDetail('113'));
    const started = between.item.runs.findIndex(run => run.id.startsWith('2fd6990d'));
    const change = between.item.progress?.change;
    if (between.item.progress === null || change == null) throw new Error('113 has a change');
    between.item.runs = between.item.runs.slice(0, started + 1);
    between.item.progress = {
      ...between.item.progress,
      change: { ...change, merged: false, mergedAt: null },
      running: null,
    };
    expect([journey(between).stopped, journey(between).until]).toEqual([null, 'now']);
    const open = structuredClone(itemDetail('3'));
    open.item.questions = [
      { kind: 'attention', ref: 'ask:open', message: 'Which?' },
    ] as unknown as FactoryItemDetail['item']['questions'];
    expect(journey(open).stopped).toBeNull();
  });

  test('not resting while the start the answer made waits for a slot or the install hold', () => {
    const queued = structuredClone(itemDetail('3'));
    queued.item.queued = [
      { workflow: 'deliver', ahead: 2 },
    ] as unknown as FactoryItemDetail['item']['queued'];
    expect([journey(queued).stopped, journey(queued).until]).toEqual([null, 'now']);
    const kept = structuredClone(itemDetail('3'));
    kept.item.held = [{ workflow: 'deliver' }] as unknown as FactoryItemDetail['item']['held'];
    expect([journey(kept).stopped, journey(kept).until]).toEqual([null, 'now']);
  });
});
