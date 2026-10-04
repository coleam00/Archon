/**
 * The console's alias form checks names with a copy of the server's rule so a
 * typo never costs a round trip. `@archon/web` cannot import the server, so this
 * runs both over the same names and requires identical results — the verdict and
 * the message the operator sees.
 */
import { describe, test, expect } from 'bun:test';
import { validateAliasName } from '../packages/server/src/routes/alias-name';
import { aliasNameError } from '../packages/web/src/experiments/console/skills/settings';

const NAMES = ['@fast', '@', 'fast', '', 'small', 'medium', 'large', '@small', 'Small', ' @fast'];

describe('alias name rule: web copy matches the server', () => {
  for (const name of NAMES) {
    test(JSON.stringify(name), () => {
      expect(aliasNameError(name)).toBe(validateAliasName(name));
    });
  }
});
