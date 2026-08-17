/**
 * Parity guard: the console's reasoning-depth ladder must equal the engine's.
 *
 * `@archon/web` must never import `@archon/workflows` or `@archon/providers`
 * (they are server packages), so the console keeps a hand-maintained copy of the
 * effort ladder — `EFFORT_OPTIONS` — beside the canonical `EFFORT_LADDER`. That
 * is a sanctioned mirror, and every sanctioned mirror needs a check, or it is
 * just a copy waiting to drift.
 *
 * This test file lives outside both packages and imports both, which does not
 * breach the rule above: the rule is about what ships in the web bundle, not
 * about what a repo-level test may read. Same reasoning, and same shape, as
 * `scripts/node-ref-parity.test.ts`.
 *
 * Why VALUE comparison rather than reading the source text: #2591 had to rebuild
 * the node-ref guard after its text-scraping version lost its target the moment
 * the constant it scraped became a `new RegExp(...)` concatenation. Comparing
 * the values is immune to how either side spells its declaration.
 *
 * The ladder is not cosmetic. It is the set of rungs a workflow may declare in
 * `effort:`, and the console offers exactly these in the tier/alias pickers. A
 * console that offers a rung the engine rejects produces a workflow that fails
 * to load; a console missing a rung the engine accepts hides a capability the
 * user is paying for. #2556 spent nine review rounds on drift between a claim
 * and the code it described — this is the one remaining unguarded copy.
 */
import { describe, test, expect } from 'bun:test';
import { EFFORT_LADDER } from '../packages/providers/src/shared/effort';
import { EFFORT_OPTIONS } from '../packages/web/src/experiments/console/lib/model-options';

describe('effort-ladder parity: @archon/web mirrors the engine', () => {
  test('the console ladder is exactly the engine ladder, in order', () => {
    // Order matters as well as membership: `clampEffort` walks the ladder to
    // find the nearest supported rung, and the console renders it as a list the
    // user reads weakest-to-strongest.
    expect([...EFFORT_OPTIONS]).toEqual([...EFFORT_LADDER]);
  });

  test('the schema enum is the same ladder, so YAML and the console agree', async () => {
    // `effortLevelSchema` derives from EFFORT_LADDER rather than restating it,
    // which is what makes the YAML surface and the clamp unable to disagree.
    // Assert that derivation still holds — a future edit could reintroduce a
    // literal here and nothing else would notice.
    const { EFFORT_LEVELS } = await import('../packages/workflows/src/schemas/dag-node');
    expect([...EFFORT_LEVELS]).toEqual([...EFFORT_LADDER]);
  });
});
