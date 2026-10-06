/**
 * A test that exists to be selected: `scripts/repo-tests.test.ts` routes the
 * `.archon/scripts/` directory through `bun run test` and filters to this one test, so
 * the route is proved without running the directory's subprocess suites.
 */
import { expect, it } from 'bun:test';
import { ROUTING_PROBE } from './routing-probe';

it(ROUTING_PROBE, () => {
  expect(true).toBe(true);
});
