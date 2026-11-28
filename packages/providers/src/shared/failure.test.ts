import { describe, expect, test } from 'bun:test';

import type { ProviderFailureClass } from '@archon/provider-contract';

import { classOfHttpStatus } from './failure';

// One table for every provider that classifies from a status alone. `5xx` is `transient`,
// never `overloaded`: a generic server error does not establish capacity (#2771's rule,
// stated in the failure classes' own documentation).
describe('classOfHttpStatus', () => {
  test.each([
    [429, 'rate_limited'],
    [401, 'auth'],
    [403, 'auth'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
    [599, 'transient'],
    [600, 'unknown'],
    [400, 'unknown'],
    [404, 'unknown'],
    [408, 'unknown'],
    [201, 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
  ] as [number | null | undefined, ProviderFailureClass][])('%p is %p', (status, expected) => {
    expect(classOfHttpStatus(status)).toBe(expected);
  });
});
