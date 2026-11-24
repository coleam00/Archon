import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import { runPositions, storyVisits } from './item-visits';

/** Each panel as "<stage label>(n)" with its own runs and the fix runs folded into it. */
const panels = (detail: FactoryItemDetail): string[] =>
  storyVisits(shippedView, detail).map(
    panel =>
      `${panel.stage.label}${panel.number > 1 ? ` (${panel.number.toString()})` : ''}` +
      ` ${panel.runIds.length.toString()}+${panel.fixRunIds.length.toString()}`
  );

describe('storyVisits', () => {
  test('item 111: one deliver run splits into Build, Checks (its fix folded in), CI and review', () => {
    expect(panels(itemDetail('111'))).toEqual([
      'Order 1+0',
      'Triage 1+0',
      'Plan 1+0',
      'Build 1+0',
      'Checks 1+1',
      'CI and review 1+0',
      'Ready to merge 1+0',
    ]);
  });

  test('item 125: builds between check rounds fold into one Checks panel; a restart numbers again', () => {
    expect(panels(itemDetail('125'))).toEqual([
      'Order 1+0',
      'Triage 1+0',
      'Plan 1+0',
      'Order (2) 1+0',
      // Triage and split are both Triage's.
      'Triage (2) 2+0',
      'Plan (2) 1+0',
      'Build 1+0',
      // Four stage-check runs; the four builds between them fixed what they sent back.
      'Checks 4+4',
      // CI sent it back, the builder fixed it, CI passed.
      'CI and review 2+1',
      'Ready to merge 2+0',
      'Merged 1+0',
    ]);
  });

  test('item 115: a replan after an ask is a second Plan panel, numbered', () => {
    expect(panels(itemDetail('115'))).toContain('Plan (2) 1+0');
    expect(panels(itemDetail('115'))).toContain('Build (2) 1+0');
  });

  test('item 86: parked after triage, two panels', () => {
    expect(panels(itemDetail('86'))).toEqual(['Order 1+0', 'Triage 1+0']);
  });
});

describe('runPositions', () => {
  const detail = itemDetail('113');
  const asked = detail.item.runs.find(run => run.outcome === 'ask');
  const facts = detail.runs.find(run => run.runId === asked?.id);
  if (asked === undefined || facts === undefined) throw new Error('item 113 asked');

  test("a run's closing steps do not move it when its outcome places it back where it worked", () => {
    // The first delivery built, then ran its closing steps (declared on CI and review) to ask.
    expect(facts.steps.map(step => step.node)).toEqual(['build__build', 'result', 'reported']);
    expect(runPositions(shippedView, asked, facts).map(p => p.stage.id)).toEqual(['build']);
  });

  test('a step no stage names leaves the run where it was; the discoveries drain is on none', () => {
    const deliver = itemDetail('111');
    const run = deliver.item.runs.find(entry => entry.workflow.endsWith(':deliver'));
    const deliverFacts = deliver.runs.find(entry => entry.runId === run?.id);
    if (run === undefined || deliverFacts === undefined) throw new Error('item 111 delivered');
    // `rounds` and `hostrounds`, the loop groups, name no stage.
    expect(runPositions(shippedView, run, deliverFacts).map(p => [p.stage.id, p.node])).toEqual([
      ['build', 'build__build'],
      ['checks', 'rounds.base'],
      ['build', 'rounds.fix'],
      ['checks', 'rounds.base'],
      ['host', 'hostrounds.host__host'],
    ]);
    const drain = deliver.item.runs.find(entry => entry.workflow.endsWith(':discoveries'));
    const drainFacts = deliver.runs.find(entry => entry.runId === drain?.id);
    if (drain === undefined) throw new Error('item 111 drained');
    expect(runPositions(shippedView, drain, drainFacts)).toEqual([]);
  });
});
