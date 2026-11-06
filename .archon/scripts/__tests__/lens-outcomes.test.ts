/**
 * The review barrier reports how each of this round's lenses ended, read from the
 * engine's node outcomes: only the lens nodes of its own include and iteration count.
 */
import { describe, expect, it } from 'bun:test';
import { packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

const frames = (iteration: number) => [{ groupId: 'rounds', iteration }];
const lens = (node_id: string, state: string, iteration: number) => ({ node_id, state, loop_group_path: frames(iteration) });

describe('lens-outcomes', () => {
  it("reports this round's lens states, ignoring another iteration and another review include", () => {
    const run = runPackScript('review/scripts/lens-outcomes', {
      inputs: {
        ARCHON_NODE_EXECUTION: JSON.stringify({ path: 'rounds.review__review-complete', invocation: { loopPath: frames(2) } }),
        NODE_OUTCOMES_FILE: '{ARTIFACTS}/outcomes.json',
      },
      artifacts: {
        'outcomes.json': JSON.stringify({
          run_id: 'run', first_failed_node: null,
          nodes: [
            lens('rounds.review__code', 'completed', 1),
            lens('rounds.review__errors', 'completed', 1),
            lens('rounds.review__code', 'failed', 2),
            lens('rounds.review__seams', 'completed', 2),
            lens('rounds.review__tests', 'skipped', 2),
            lens('rounds.rereview__docs', 'completed', 2),
          ],
        }),
      },
    });
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      seams: 'completed', code: 'failed', tests: 'skipped', errors: 'unreadable', docs: 'unreadable', ux: 'unreadable',
    });
  });
});
