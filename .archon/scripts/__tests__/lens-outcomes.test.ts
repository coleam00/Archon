/**
 * The review barrier reports how each of this round's lenses ended, read from the
 * engine's node outcomes: only the lens nodes of its own include and iteration count.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REVIEW_LENSES } from '../../workflows/sdlc/.shared/review-policy';
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

// The review block restates the lens set in its route and mode schemas, its lens nodes'
// `when` gates and the barrier's `depends_on`; REVIEW_LENSES owns it.
describe('archon-review-block lens wiring', () => {
  const block = Bun.YAML.parse(
    readFileSync(resolve(import.meta.dir, '../../workflows/sdlc/review/archon-review-block.yaml'), 'utf8')
  ) as { nodes: { id: string; when?: string; depends_on?: string[]; output_format?: { properties: object; required: string[] } }[] };
  const node = (id: string) => block.nodes.find(n => n.id === id);

  it('declares every REVIEW_LENSES lens in the route and mode outputs, as a gated node, and at the barrier', () => {
    for (const id of ['route', 'mode']) {
      const format = node(id)?.output_format;
      for (const lens of REVIEW_LENSES) {
        expect(format?.properties).toHaveProperty(lens);
        expect(format?.required).toContain(lens);
      }
    }
    for (const lens of REVIEW_LENSES) {
      const gate = node(lens)?.when ?? '';
      expect([...gate.matchAll(/\$(?:route|mode)\.output\.(\w+) == true/g)].map(m => m[1])).toEqual([lens, lens]);
    }
    expect(node('review-complete')?.depends_on).toEqual(expect.arrayContaining([...REVIEW_LENSES]));
  });
});
