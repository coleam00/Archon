import { describe, expect, test } from 'bun:test';
import { legacyDestination } from './LegacyRedirect';

describe('Old entry URLs', () => {
  test('resolve into the console without retaining a second application', () => {
    expect(legacyDestination('/legacy', '')).toBe('/console');
    expect(legacyDestination('/legacy/dashboard', '')).toBe('/console');
    expect(legacyDestination('/legacy/settings', '')).toBe('/console/settings');
    expect(legacyDestination('/legacy/chat/old-conversation', '')).toBe('/console');
    expect(legacyDestination('/legacy/workflows', '')).toBe('/console/builder');
  });
  test('preserve run IDs independently of project membership', () => {
    expect(legacyDestination('/legacy/workflows/runs/run-123', '')).toBe('/console/r/run-123');
    expect(legacyDestination('/workflows/runs/run-123', '')).toBe('/console/r/run-123');
  });
  test('carry a builder target and explicit project into the live experiment', () => {
    expect(
      legacyDestination('/legacy/workflows/builder', '?edit=my%20workflow&project=p-123')
    ).toBe('/console/builder/my%20workflow?project=p-123');
  });
});
