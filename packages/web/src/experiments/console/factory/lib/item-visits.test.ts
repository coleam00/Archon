import { describe, expect, test } from 'bun:test';
import type { FactoryItemDetail } from '../../skills/factory';
import { itemDetail, shippedView } from '../item-detail.test-fixtures';
import { storyVisits } from './item-visits';

/** Each panel as "<stage label>(n)" with its own runs and the fix runs folded into it. */
const panels = (detail: FactoryItemDetail): string[] =>
  storyVisits(shippedView, detail).map(
    panel =>
      `${panel.stage.label}${panel.number > 1 ? ` (${panel.number.toString()})` : ''}` +
      ` ${panel.runIds.length.toString()}+${panel.fixRunIds.length.toString()}`
  );

describe('storyVisits', () => {
  test('item 111: one deliver run splits into Build, Checks (its fix folded in), CI and review; the drain is on none', () => {
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

  test("item 113: a run's closing steps do not move it out of the stage it worked", () => {
    // The first delivery built, then ran its closing steps (declared on CI and review) to ask:
    // it stays on Build, beside the delivery the answer started.
    expect(panels(itemDetail('113'))).toEqual([
      'Order 1+0',
      'Triage 1+0',
      'Plan 1+0',
      'Build 2+0',
      'Checks 1+0',
      'CI and review 1+0',
      'Ready to merge 1+0',
    ]);
  });
});
