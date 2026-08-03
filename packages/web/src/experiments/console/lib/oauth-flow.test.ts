import { describe, expect, test } from 'bun:test';
import { mergeOAuthSignals } from './oauth-flow';
import type { ProviderOAuthPoll, ProviderOAuthStart } from '../skills';

function start(overrides: Partial<ProviderOAuthStart> = {}): ProviderOAuthStart {
  return { sessionId: 's1', mode: 'manual', expiresIn: 600, ...overrides };
}

describe('mergeOAuthSignals', () => {
  test('adopts a late-arriving manual URL from the poll response', () => {
    // The VPS bug: start raced past pi's onAuth (supersede latency), so the
    // URL only ever appeared in poll responses — and was dropped.
    const merged = mergeOAuthSignals(start(), {
      status: 'pending',
      mode: 'manual',
      url: 'https://claude.ai/oauth/authorize?x=1',
    });
    expect(merged.url).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(merged.mode).toBe('manual');
  });

  test('adopts late device-flow signals (userCode + verificationUri + mode flip)', () => {
    const merged = mergeOAuthSignals(start({ mode: 'manual' }), {
      status: 'pending',
      mode: 'device',
      userCode: 'WXYZ-1234',
      verificationUri: 'https://github.com/login/device',
    });
    expect(merged.mode).toBe('device');
    expect(merged.userCode).toBe('WXYZ-1234');
    expect(merged.verificationUri).toBe('https://github.com/login/device');
  });

  test('start-provided signals win over poll values (no flapping)', () => {
    const s = start({ url: 'https://claude.ai/oauth/authorize?orig=1' });
    const merged = mergeOAuthSignals(s, {
      status: 'pending',
      url: 'https://claude.ai/oauth/authorize?other=2',
    });
    expect(merged.url).toBe('https://claude.ai/oauth/authorize?orig=1');
  });

  test('returns the SAME reference when the poll adds nothing (render stability)', () => {
    const s = start({ url: 'https://claude.ai/oauth/authorize?x=1' });
    const noNews: ProviderOAuthPoll = { status: 'pending' };
    expect(mergeOAuthSignals(s, noNews)).toBe(s);
    // status-only churn never produces a new object
    expect(mergeOAuthSignals(s, { status: 'pending', mode: 'manual' })).toBe(s);
  });
});
