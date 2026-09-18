/**
 * A script node must be able to find user-installed tools.
 *
 * The server's own PATH does not include `$HOME/.local/bin`:
 *
 *   /app/packages/server:...:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
 *
 * That is where `uv`, `pipx`, `pip --user` and `cargo install` put binaries, so
 * a script node calling any of them dies at `Executable not found in $PATH`.
 * Observed on 0.6.0: a DAG workflow wrote its commits, pushed them and opened a
 * PR, then hit a `uv`-based validation node and reported the entire run failed.
 * $19 of completed work recorded as a failure — output intact, report wrong.
 */
import { describe, expect, test } from 'bun:test';

import { withUserLocalBin } from './exec-environment';

describe('withUserLocalBin', () => {
  test('prepends $HOME/.local/bin to an existing PATH', () => {
    const out = withUserLocalBin({ HOME: '/home/agent', PATH: '/usr/bin:/bin' });
    expect(out.PATH).toBe('/home/agent/.local/bin:/usr/bin:/bin');
  });

  test('prepends rather than appends, so a user toolchain wins', () => {
    // Installing into ~/.local/bin is a request to use THAT version.
    const out = withUserLocalBin({ HOME: '/home/agent', PATH: '/usr/bin' });
    expect(out.PATH!.startsWith('/home/agent/.local/bin:')).toBe(true);
  });

  test('supplies a PATH when the bag carries none', () => {
    // The container case: the Archon-managed bag has no PATH at all, so the
    // container falls back to its image default and never sees ~/.local/bin.
    const out = withUserLocalBin({ HOME: '/home/agent' });
    expect(out.PATH).toBe('/home/agent/.local/bin');
  });

  test('is idempotent', () => {
    const once = withUserLocalBin({ HOME: '/home/agent', PATH: '/usr/bin' });
    const twice = withUserLocalBin(once);
    expect(twice.PATH).toBe(once.PATH);
  });

  test('does not duplicate an entry already present anywhere in PATH', () => {
    const out = withUserLocalBin({
      HOME: '/home/agent',
      PATH: '/usr/bin:/home/agent/.local/bin',
    });
    expect(out.PATH).toBe('/usr/bin:/home/agent/.local/bin');
  });

  test('is a no-op without HOME rather than inventing a path', () => {
    const input = { PATH: '/usr/bin' };
    const out = withUserLocalBin(input);
    expect(out.PATH).toBe('/usr/bin');
  });

  test('does not mutate the caller’s object', () => {
    const input = { HOME: '/home/agent', PATH: '/usr/bin' };
    withUserLocalBin(input);
    expect(input.PATH).toBe('/usr/bin');
  });
});
