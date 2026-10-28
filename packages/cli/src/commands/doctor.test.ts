import { describe, it, expect, spyOn, afterEach, beforeEach } from 'bun:test';
import { doctorCommand } from './doctor';

describe('doctorCommand', () => {
  let logSpy: ReturnType<typeof spyOn<Console, 'log'>>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const passing = (label: string) => async () =>
    ({ label, status: 'pass', message: 'ok' }) as const;
  const failing = (label: string) => async () =>
    ({ label, status: 'fail', message: 'broken' }) as const;
  const skipping = (label: string) => async () =>
    ({ label, status: 'skip', message: 'no token' }) as const;
  const warning = (label: string) => async () =>
    ({ label, status: 'warn', message: 'worth knowing' }) as const;
  const throwing = (label: string) => async (): Promise<never> => {
    throw new Error(`${label} blew up`);
  };

  const summary = (): string | undefined =>
    logSpy.mock.calls.map(args => String(args[0] ?? '')).at(-1);

  it('returns 0 when every check passes', async () => {
    const exit = await doctorCommand([passing('A'), passing('B')]);
    expect(exit).toBe(0);
    expect(summary()).toBe('All checks passed.');
  });

  it('returns 0 when checks are pass + skip (skip is not a failure)', async () => {
    const exit = await doctorCommand([passing('A'), skipping('B')]);
    expect(exit).toBe(0);
  });

  it('returns 1 when any check fails', async () => {
    const exit = await doctorCommand([passing('A'), failing('B')]);
    expect(exit).toBe(1);
  });

  it('counts a thrown check as a failure (allSettled rejection branch)', async () => {
    const exit = await doctorCommand([passing('A'), throwing('B')]);
    expect(exit).toBe(1);
  });

  it('continues after a thrown check (Promise.allSettled does not short-circuit)', async () => {
    const exit = await doctorCommand([throwing('A'), passing('B'), failing('C')]);
    // 1 throw + 1 fail = 2 failures, but exit code is still 1.
    expect(exit).toBe(1);
    // Verify all three were rendered (one per ✓/✗/unknown line).
    const renderedLines = logSpy.mock.calls
      .map(args => String(args[0] ?? ''))
      .filter(s => s.startsWith('✓') || s.startsWith('✗') || s.startsWith('○'));
    expect(renderedLines.length).toBeGreaterThanOrEqual(2);
  });

  it('a warn is not a failure: exit 0, but it is still rendered', async () => {
    // `warn` reports a defect the operator should see on an install that
    // works (e.g. an expired-but-refreshable Pi access token). It must not
    // flip the exit code — that would break CI on healthy installs — yet it
    // must still reach the operator rather than being swallowed.
    const exit = await doctorCommand([passing('A'), warning('B')]);
    expect(exit).toBe(0);
    expect(summary()).toBe('No check failed; 1 warning(s) above.');

    const warnLine = logSpy.mock.calls
      .map(args => String(args[0] ?? ''))
      .find(s => s.startsWith('!'));
    expect(warnLine).toContain('B');
    expect(warnLine).toContain('worth knowing');
  });
});
