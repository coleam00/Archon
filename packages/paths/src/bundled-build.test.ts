import { describe, expect, it } from 'bun:test';
import { BUNDLED_GIT_COMMIT, BUNDLED_IS_BINARY, BUNDLED_VERSION } from './bundled-build';

describe('bundled-build', () => {
  // In dev/test mode the placeholders must be the dev defaults.
  // `scripts/build-binaries.sh` rewrites this file only during binary
  // compilation and restores it afterwards via an EXIT trap.
  it('BUNDLED_IS_BINARY is false in dev mode', () => {
    expect(BUNDLED_IS_BINARY).toBe(false);
  });

  it('BUNDLED_VERSION is the dev placeholder', () => {
    expect(BUNDLED_VERSION).toBe('dev');
  });

  it('BUNDLED_GIT_COMMIT is the dev placeholder', () => {
    expect(BUNDLED_GIT_COMMIT).toBe('unknown');
  });
});
