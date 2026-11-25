/**
 * The console's `readOutcome` is a copy of the engine's `displayedRunOutcome`: the web
 * package cannot import @archon/workflows. This executes both over every status and a
 * spread of stored values, so the copy cannot drift.
 */
import { describe, expect, test } from 'bun:test';
import { readOutcome } from '../packages/web/src/experiments/console/primitives/run';
import {
  workflowRunOutcomeSchema,
  workflowRunStatusSchema,
} from '../packages/workflows/src/schemas/run-status';
import { displayedRunOutcome } from '../packages/workflows/src/schemas/workflow-run';

describe('the console shows the outcome the engine displays', () => {
  for (const status of workflowRunStatusSchema.options) {
    for (const outcome of [null, ...workflowRunOutcomeSchema.options]) {
      for (const completed_outcome of [null, 'built', 'failed']) {
        const run = { status, outcome, completed_outcome };
        test(JSON.stringify(run), () => {
          expect(readOutcome(run)).toBe(displayedRunOutcome(run));
        });
      }
    }
  }
});
