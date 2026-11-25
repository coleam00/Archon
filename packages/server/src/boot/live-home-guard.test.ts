import { describe, expect, test } from 'bun:test';
import { join, sep } from 'node:path';
import { getArchonHome } from '@archon/paths';
import { liveHomeRefusal } from './live-home-guard';

// The package preload points ARCHON_HOME at a scratch directory, so this is the home the guard compares against.
const home = getArchonHome();

describe('liveHomeRefusal', () => {
  test('a server with no live factory home set starts', () => {
    expect(liveHomeRefusal({})).toBeNull();
  });

  test('a server on a different home from the live factory starts', () => {
    expect(liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: join(home, 'other') })).toBeNull();
  });

  test('a server on the live factory home is refused', () => {
    expect(liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: home })).not.toBeNull();
  });

  test('the live home named in different case is still refused', () => {
    expect(liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: home.toUpperCase() })).not.toBeNull();
    expect(liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: home.toLowerCase() })).not.toBeNull();
  });

  test('the live home named with a trailing separator is still refused', () => {
    expect(liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: home + sep })).not.toBeNull();
  });

  test('the operator’s own server may serve the live home', () => {
    expect(
      liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: home, ARCHON_FACTORY_LIVE_SERVE: '1' })
    ).toBeNull();
  });

  test('only ARCHON_FACTORY_LIVE_SERVE=1 opts in to serving the live home', () => {
    for (const value of ['0', 'true', '']) {
      expect(
        liveHomeRefusal({ ARCHON_FACTORY_LIVE_HOME: home, ARCHON_FACTORY_LIVE_SERVE: value })
      ).not.toBeNull();
    }
  });
});
