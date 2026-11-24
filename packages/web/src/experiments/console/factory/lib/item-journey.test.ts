import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import { itemJourney, type Journey } from './item-journey';
import { itemColumn, placementInput } from './placement';

const NOW = Date.parse('2026-11-22T09:00:00Z');

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

describe('the time of each column', () => {
  test("item 111: the columns' times are the time from order to merge", () => {
    const detail = itemDetail('111');
    const of = journey(detail);
    expect(of.segments.reduce((sum, entry) => sum + entry.ms, 0)).toBe(of.totalMs);
    const first = Date.parse(detail.item.runs[0]?.startedAt ?? '');
    const merged = Date.parse(detail.item.progress?.change?.mergedAt ?? '');
    expect([of.totalMs, of.until]).toEqual([merged - first, 'merge']);
    expect(of.segments.every(entry => entry.reached)).toBe(true);
  });

  test('item 86, parked: its time ends where it stopped, not now', () => {
    const of = journey(itemDetail('86'));
    expect(of.until).toBe('stop');
    expect(of.totalMs).toBe(journey(itemDetail('86'), NOW + 3_600_000).totalMs);
  });

  test('item 125: four send-backs to Plan & build, and the restart at intake', () => {
    const of = journey(itemDetail('125'));
    expect(segment(of, 'checks-review').loops).toEqual([{ to: 'Plan & build', count: 4 }]);
    expect(segment(of, 'plan-build').loops).toEqual([{ to: 'Intake', count: 1 }]);
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
});
