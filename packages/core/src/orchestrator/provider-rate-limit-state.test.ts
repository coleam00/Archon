import { describe, expect, test } from 'bun:test';
import {
  formatProviderCooldownMessage,
  getProviderCooldown,
  getProviderUsageWarning,
  recordProviderCooldown,
  recordProviderUsageWarning,
} from './provider-rate-limit-state';

describe('provider chat cooldown state', () => {
  test('retains a valid typed Claude subscription warning until reset and scopes it by credential', () => {
    const scope = `usage-warning-${crypto.randomUUID()}`;
    const otherScope = `${scope}-other`;
    const now = 1_700_000_000_000;
    const resetsAt = now / 1_000 + 60;
    const warning = recordProviderUsageWarning(
      'claude',
      scope,
      {
        status: 'allowed_warning',
        resetsAt,
        rateLimitType: 'five_hour',
      },
      now
    );

    expect(warning).toEqual({
      provider: 'claude',
      resetAt: resetsAt * 1_000,
      rateLimitType: 'five_hour',
    });
    expect(getProviderUsageWarning('claude', scope, now + 1)).toEqual(warning);
    expect(getProviderUsageWarning('claude', otherScope, now + 1)).toBeUndefined();
    expect(getProviderUsageWarning('claude', scope, resetsAt * 1_000)).toBeUndefined();
  });

  test('ignores malformed or unknown windows and clears an allowed warning for the same window', () => {
    const scope = `usage-clear-${crypto.randomUUID()}`;
    const now = 1_700_000_000_000;
    const resetsAt = now / 1_000 + 60;

    for (const rateLimitInfo of [
      { status: 'allowed_warning', resetsAt, rateLimitType: 'unknown' },
      { status: 'allowed_warning', resetsAt: now + 60_000, rateLimitType: 'five_hour' },
      { status: 'allowed_warning', resetsAt, rateLimitType: 'five_hour_typo' },
      { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
    ]) {
      expect(recordProviderUsageWarning('claude', scope, rateLimitInfo, now)).toBeUndefined();
    }
    expect(
      recordProviderUsageWarning(
        'codex',
        scope,
        { status: 'allowed_warning', resetsAt, rateLimitType: 'five_hour' },
        now
      )
    ).toBeUndefined();

    recordProviderUsageWarning(
      'claude',
      scope,
      { status: 'allowed_warning', resetsAt, rateLimitType: 'five_hour' },
      now
    );
    expect(
      recordProviderUsageWarning(
        'claude',
        scope,
        { status: 'allowed', resetsAt: resetsAt + 1, rateLimitType: 'five_hour' },
        now + 1
      )
    ).toBeUndefined();
    expect(getProviderUsageWarning('claude', scope, now + 1)).toBeUndefined();
    expect(
      recordProviderUsageWarning(
        'claude',
        scope,
        { status: 'allowed', resetsAt, rateLimitType: 'five_hour' },
        now + 2
      )
    ).toBeUndefined();
    expect(getProviderUsageWarning('claude', scope, now + 2)).toBeUndefined();
  });

  test('clears only the matching warning when Claude reports multiple windows', () => {
    const scope = `multi-window-${crypto.randomUUID()}`;
    const now = 1_700_000_000_000;
    const fiveHourReset = now / 1_000 + 60;
    const sevenDayReset = now / 1_000 + 120;

    recordProviderUsageWarning(
      'claude',
      scope,
      { status: 'allowed_warning', resetsAt: fiveHourReset, rateLimitType: 'five_hour' },
      now
    );
    recordProviderUsageWarning(
      'claude',
      scope,
      { status: 'allowed_warning', resetsAt: sevenDayReset, rateLimitType: 'seven_day' },
      now
    );

    recordProviderUsageWarning(
      'claude',
      scope,
      { status: 'allowed', resetsAt: fiveHourReset, rateLimitType: 'five_hour' },
      now + 1
    );

    expect(getProviderUsageWarning('claude', scope, now + 1)).toEqual({
      provider: 'claude',
      resetAt: sevenDayReset * 1_000,
      rateLimitType: 'seven_day',
    });
  });

  test('records only a Claude SDK rejected event with its provider reset timestamp', () => {
    const scope = `signal-${crypto.randomUUID()}`;
    const observed = recordProviderCooldown(
      'claude',
      scope,
      {
        status: 'rejected',
        resetsAt: 15,
        rateLimitType: 'five_hour',
        utilization: 1,
      },
      10_000
    );

    expect(observed).toEqual({ provider: 'claude', resetAt: 15_000, rateLimitType: 'five_hour' });
    expect(getProviderCooldown('claude', scope, 10_001)).toEqual(observed);
  });

  test('does not block a rejected base quota when Claude reports that overage is still allowed', () => {
    const scope = `overage-${crypto.randomUUID()}`;
    const now = 1_700_000_000_000;
    const resetsAt = now / 1_000 + 60;

    expect(
      recordProviderCooldown(
        'claude',
        scope,
        { status: 'rejected', resetsAt, overageStatus: 'allowed' },
        now
      )
    ).toBeUndefined();
    expect(getProviderCooldown('claude', scope, now)).toBeUndefined();
  });

  test('does not infer rejection from utilization, allowed statuses, or another provider payload', () => {
    const scope = `no-inference-${crypto.randomUUID()}`;
    const now = 1_700_000_000_000;
    const resetsAt = now / 1_000 + 60;

    expect(
      recordProviderCooldown('claude', scope, { utilization: 1, resetsAt }, now)
    ).toBeUndefined();
    expect(
      recordProviderCooldown('claude', scope, { status: 'allowed', resetsAt, utilization: 1 }, now)
    ).toBeUndefined();
    expect(
      recordProviderCooldown(
        'claude',
        scope,
        { status: 'allowed_warning', resetsAt, utilization: 1 },
        now
      )
    ).toBeUndefined();
    expect(
      recordProviderCooldown('codex', scope, { status: 'rejected', resetsAt }, now)
    ).toBeUndefined();
    expect(getProviderCooldown('claude', scope, 1)).toBeUndefined();
  });

  test('requires a valid bounded future reset timestamp and expires exactly at reset', () => {
    const scope = `expiry-${crypto.randomUUID()}`;
    const now = 1_700_000_000_000;
    const nowSeconds = now / 1_000;
    const sevenDaysSeconds = 7 * 24 * 60 * 60;

    for (const resetsAt of [
      undefined,
      null,
      '3000',
      nowSeconds,
      nowSeconds - 1,
      nowSeconds + 1.5,
      Number.NaN,
      nowSeconds + sevenDaysSeconds + 1,
      now + 20_000,
    ]) {
      expect(
        recordProviderCooldown('claude', scope, { status: 'rejected', resetsAt }, now)
      ).toBeUndefined();
    }

    const resetAtSeconds = nowSeconds + 20;
    recordProviderCooldown('claude', scope, { status: 'rejected', resetsAt: resetAtSeconds }, now);
    expect(getProviderCooldown('claude', scope, now + 19_999)).toEqual({
      provider: 'claude',
      resetAt: resetAtSeconds * 1_000,
    });
    expect(getProviderCooldown('claude', scope, resetAtSeconds * 1_000)).toBeUndefined();

    const boundaryScope = `expiry-boundary-${crypto.randomUUID()}`;
    const maxCooldown = recordProviderCooldown(
      'claude',
      boundaryScope,
      { status: 'rejected', resetsAt: nowSeconds + sevenDaysSeconds },
      now
    );
    expect(maxCooldown).toEqual({
      provider: 'claude',
      resetAt: now + sevenDaysSeconds * 1_000,
    });
  });

  test('keeps cooldowns scoped to provider and credential scope', () => {
    const scopeA = `scope-a-${crypto.randomUUID()}`;
    const scopeB = `scope-b-${crypto.randomUUID()}`;
    const now = 1_700_000_000_000;
    const resetAt = now + 100_000;
    recordProviderCooldown(
      'claude',
      scopeA,
      { status: 'rejected', resetsAt: resetAt / 1_000 },
      now
    );

    expect(getProviderCooldown('claude', scopeA, now + 1)).toEqual({
      provider: 'claude',
      resetAt,
    });
    expect(getProviderCooldown('claude', scopeB, now + 1)).toBeUndefined();
    expect(getProviderCooldown('codex', scopeA, now + 1)).toBeUndefined();
  });

  test('formats the signal as a provider report and never suggests automatic fallback', () => {
    const cooldown = {
      provider: 'claude' as const,
      resetAt: Date.UTC(2026, 8, 25, 12, 0, 0),
    };
    const message = formatProviderCooldownMessage(cooldown, false);

    expect(message).toContain('Claude reports that this provider credential is rate-limited');
    expect(message).toContain('2026-09-25T12:00:00.000Z');
    expect(message).toContain('Archon did not send this message to the provider');
    expect(message).toContain(
      'will not automatically replay this message or switch providers mid-turn'
    );
    expect(message).toContain(
      'A configured task fallback may be selected for a later independent message'
    );
    expect(message).toContain('change your provider/model explicitly');
    expect(formatProviderCooldownMessage(cooldown, true)).toContain('the reply may be incomplete');
  });
});
