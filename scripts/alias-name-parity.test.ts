/**
 * The console's alias form checks names with a copy of the server's rule so a
 * typo never costs a round trip. `@archon/web` cannot import the server or
 * `@archon/workflows`, so this runs both over the same names and requires
 * identical results — the verdict and the message the operator sees. The tier
 * names come from the workflows schema, so a new tier is checked here without
 * an edit, and the web's own tier list must equal it.
 */
import { describe, test, expect } from 'bun:test';
import { TIER_NAMES } from '../packages/workflows/src/schemas/model-binding';
import { validateAliasName } from '../packages/server/src/routes/alias-name';
import {
  TIER_ORDER,
  aliasNameError,
} from '../packages/web/src/experiments/console/skills/settings';

const NAMES = [
  ...TIER_NAMES,
  ...TIER_NAMES.map(tier => `@${tier}`),
  '@fast',
  '@',
  'fast',
  '',
  'Small',
  ' @fast',
];

describe('alias name rule: web copy matches the server', () => {
  test('web tier list equals the workflows tier names', () => {
    expect([...TIER_ORDER]).toEqual([...TIER_NAMES]);
  });

  for (const name of NAMES) {
    test(JSON.stringify(name), () => {
      expect(aliasNameError(name)).toBe(validateAliasName(name));
    });
  }
});
