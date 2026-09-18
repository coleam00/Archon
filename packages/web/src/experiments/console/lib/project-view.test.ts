import { describe, test, expect } from 'bun:test';
import { parseProjectView, projectViewKey } from './project-view';

describe('parseProjectView', () => {
  test('accepts the two real views', () => {
    expect(parseProjectView('runs')).toBe('runs');
    expect(parseProjectView('chat')).toBe('chat');
  });

  test('an absent preference reads as null', () => {
    expect(parseProjectView(null)).toBeNull();
  });

  test('an unrecognised value reads as no preference, not as a route', () => {
    // A stale key from an older build, or a hand-edited value, must not send
    // the user to a view that does not exist.
    expect(parseProjectView('builder')).toBeNull();
    expect(parseProjectView('')).toBeNull();
    expect(parseProjectView('RUNS')).toBeNull();
  });
});

describe('projectViewKey', () => {
  test('scopes the preference per project', () => {
    expect(projectViewKey('a')).not.toBe(projectViewKey('b'));
  });

  test('is namespaced so it cannot collide with another console key', () => {
    expect(projectViewKey('a')).toStartWith('archon.console.');
  });
});
