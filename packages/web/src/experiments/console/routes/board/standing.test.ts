import { expect, test } from 'bun:test';
import type { ItemRead } from '../../skills/items';
import { stageAt } from './standing';

const STAGES = ['plan', 'build'].map(workflow => ({ name: `acme/flow:${workflow}`, workflow }));

/** An item standing at its one run of `workflow`, recorded in its pack or (null) not. */
function standingOn(workflow: string, recorded: string | null): ItemRead {
  return {
    standing: { runId: 'r1', state: 'waiting', pack: 'flow' },
    runs: [
      {
        id: 'r1',
        workflow,
        pack: recorded === null ? null : { key: 'flow', workflow: recorded },
      },
    ],
  } as unknown as ItemRead;
}

test('a retired workflow places at the stage the view maps it to, recorded or by its name', () => {
  const retired = [{ workflow: 'deliver', stage: 'build' }];
  expect(stageAt(standingOn('acme/flow:deliver', 'deliver'), STAGES, retired)).toBe('build');
  expect(stageAt(standingOn('acme/flow:deliver', null), STAGES, retired)).toBe('build');
});

test('a retired workflow with no stage, or none retired, places nowhere', () => {
  const bare = [{ workflow: 'deliver', stage: null }];
  expect(stageAt(standingOn('acme/flow:deliver', 'deliver'), STAGES, bare)).toBeUndefined();
  expect(stageAt(standingOn('acme/flow:deliver', null), STAGES, bare)).toBeUndefined();
  expect(stageAt(standingOn('acme/flow:deliver', null), STAGES)).toBeUndefined();
  // Another pack's prefix is not this pack's retired workflow.
  const other = standingOn('acme/other:deliver', null);
  expect(stageAt(other, STAGES, [{ workflow: 'deliver', stage: 'build' }])).toBeUndefined();
});

test('a stage of the graph places as before, by record or by published name', () => {
  expect(stageAt(standingOn('acme/flow:plan', 'plan'), STAGES)).toBe('plan');
  expect(stageAt(standingOn('acme/flow:plan', null), STAGES)).toBe('plan');
});
