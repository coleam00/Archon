import { describe, test, expect } from 'bun:test';
import { classifyError, decide } from './index.ts';

describe('classifyError — workflow-runtime classes (BDC 2026-05-16)', () => {
  test('sentinel_mismatch: loop node + SDK returned success message', () => {
    expect(
      classifyError({
        message: "Loop 'implement' iteration 1 failed: SDK returned success",
        nodeType: 'loop',
      })
    ).toBe('sentinel_mismatch');
  });

  test("npm_not_found: bash 'command not found: npm'", () => {
    expect(
      classifyError({
        message: 'bash: line 3: npm: command not found',
        nodeId: 'verify-build',
        exitCode: 127,
      })
    ).toBe('npm_not_found');
  });

  test('npm_not_found: also catches npx, pnpm, yarn', () => {
    expect(classifyError({ message: 'command not found: npx' })).toBe('npm_not_found');
    expect(classifyError({ message: 'command not found: pnpm' })).toBe('npm_not_found');
    expect(classifyError({ message: 'command not found: yarn' })).toBe('npm_not_found');
  });

  test("worktree_collision: 'is already used by worktree'", () => {
    expect(
      classifyError({
        message:
          "fatal: 'master' is already used by worktree at '/.archon/workspaces/.../thread-abc'",
      })
    ).toBe('worktree_collision');
  });

  test("worktree_collision: 'a branch named dev already exists'", () => {
    expect(
      classifyError({
        message: "fatal: a branch named 'dev' already exists",
      })
    ).toBe('worktree_collision');
  });

  test("branch_ref_missing: 'fatal: couldn't find remote ref'", () => {
    expect(
      classifyError({
        message: "fatal: couldn't find remote ref master",
      })
    ).toBe('branch_ref_missing');
  });

  test("spec_lookup_failed: read-spec node + exit 1 + 'Spec not found'", () => {
    expect(
      classifyError({
        message: 'Spec not found for WO_ID=WO-FOO-BAR-01',
        nodeId: 'read-spec',
        exitCode: 1,
      })
    ).toBe('spec_lookup_failed');
  });

  test("verify_pre_existing: verify-* node + non-zero exit + no 'not found'", () => {
    expect(
      classifyError({
        message: 'FAIL: expected >= 6 tests, got 2',
        nodeId: 'verify-tests',
        exitCode: 1,
      })
    ).toBe('verify_pre_existing');
  });
});

describe('classifyError — provider classes (ported from router.py)', () => {
  test('rate_limit_exceeded: 429 status', () => {
    expect(classifyError({ statusCode: 429, message: 'Rate limit exceeded' })).toBe(
      'rate_limit_exceeded'
    );
  });

  test("out_of_credits: 'Credit balance is too low'", () => {
    expect(classifyError({ message: 'Credit balance is too low' })).toBe('out_of_credits');
  });

  test('service_unavailable: 5xx status', () => {
    expect(classifyError({ statusCode: 503, message: 'Service unavailable' })).toBe(
      'service_unavailable'
    );
    expect(classifyError({ statusCode: 500 })).toBe('service_unavailable');
  });

  test('auth_failed: 401, invalid_grant, refresh_expired', () => {
    expect(classifyError({ statusCode: 401, message: 'auth failed' })).toBe('auth_failed');
    expect(classifyError({ message: 'invalid_grant: refresh token expired' })).toBe('auth_failed');
    expect(
      classifyError({ message: 'Cauldron auth for claude is dead (reason: refresh_expired)' })
    ).toBe('auth_failed');
  });

  test('invalid_request: 400 status', () => {
    expect(classifyError({ statusCode: 400, message: 'bad json' })).toBe('invalid_request');
  });
});

describe('classifyError — fallback', () => {
  test('unknown for unrecognized input', () => {
    expect(classifyError({ message: 'something weird happened' })).toBe('unknown');
    expect(classifyError({})).toBe('unknown');
  });
});

describe('decide — provider classes', () => {
  test('rate_limit retries with exponential backoff up to attempt 3', () => {
    const r1 = decide({ errorClass: 'rate_limit_exceeded', attempt: 1 });
    expect(r1.decision).toBe('retry');
    expect(r1.backoffMs).toBe(2000); // 2 * 2^1 = 2000? actually 1000*2^1 = 2000... wait
    // Formula in decide.ts: 1000 * Math.pow(2, attempt) → attempt 1 = 2000ms
    expect(r1.backoffMs).toBeGreaterThan(0);

    const r3 = decide({ errorClass: 'rate_limit_exceeded', attempt: 3 });
    expect(r3.decision).toBe('escalate');
  });

  test('out_of_credits escalates (provider failover deferred to v2)', () => {
    expect(decide({ errorClass: 'out_of_credits', attempt: 1 }).decision).toBe('escalate');
  });

  test('auth_failed escalates (cron handles refresh, manual /login if persists)', () => {
    expect(decide({ errorClass: 'auth_failed', attempt: 1 }).decision).toBe('escalate');
  });
});

describe('decide — workflow-runtime classes', () => {
  test('sentinel_mismatch with output → commit_and_push_anyway', () => {
    const r = decide({ errorClass: 'sentinel_mismatch', attempt: 1, hasOutput: true });
    expect(r.decision).toBe('commit_and_push_anyway');
  });

  test('sentinel_mismatch without output → escalate', () => {
    const r = decide({ errorClass: 'sentinel_mismatch', attempt: 1, hasOutput: false });
    expect(r.decision).toBe('escalate');
  });

  test('npm_not_found → skip (legacy YAML; container is bun-only)', () => {
    const r = decide({ errorClass: 'npm_not_found', attempt: 1 });
    expect(r.decision).toBe('skip');
  });

  test("verify_pre_existing → skip (post-Patch-1, verify-* shouldn't exist; if it does, ignore)", () => {
    const r = decide({ errorClass: 'verify_pre_existing', attempt: 1 });
    expect(r.decision).toBe('skip');
  });

  test('worktree_collision → escalate (Rule 17 violation in YAML)', () => {
    const r = decide({ errorClass: 'worktree_collision', attempt: 1 });
    expect(r.decision).toBe('escalate');
  });

  test('branch_ref_missing → escalate (Rule 16 violation)', () => {
    const r = decide({ errorClass: 'branch_ref_missing', attempt: 1 });
    expect(r.decision).toBe('escalate');
  });

  test('spec_lookup_failed retries once then escalates', () => {
    expect(decide({ errorClass: 'spec_lookup_failed', attempt: 1 }).decision).toBe('retry');
    expect(decide({ errorClass: 'spec_lookup_failed', attempt: 2 }).decision).toBe('escalate');
  });
});

describe('decide — unknown', () => {
  test('unknown class → escalate (preserve current behavior)', () => {
    const r = decide({ errorClass: 'unknown', attempt: 1 });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('unknown');
  });
});
