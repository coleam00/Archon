import { describe, expect, it } from 'bun:test';
import { baseRef, run, legacy, rule, produce, verdict } from './fixtures/required-checks';

describe('required GitHub checks from exact-base policy and actual checks', () => {
  it('produces required evidence through the executable plugin protocol', async () => {
    expect(await verdict({ rules: [rule], subprocess: true })).toMatchObject({
      required: { state: 'green', counts: { total: 1 } },
      base_ref: baseRef,
    });
  });
  it('distinguishes known absence from no CI', async () => {
    expect(await verdict({ runs: [] })).toMatchObject({
      state: 'none',
      base_ref: baseRef,
      required: { state: 'none', counts: { total: 0 } },
    });
  });
  it('unions legacy and inherited rules, deduplicating exact app/context requirements', async () => {
    expect(
      await verdict({
        protection: legacy,
        rules: [
          rule,
          {
            ...rule,
            parameters: {
              required_status_checks: [{ context: 'external' }],
            },
          },
        ],
        statuses: [{ id: 2, context: 'external', state: 'failure' }],
      })
    ).toMatchObject({
      required: { state: 'red', counts: { total: 2, green: 1, red: 1 } },
    });
  });
  it('counts a missing required context as pending despite unrelated green CI', async () => {
    expect(
      await verdict({
        rules: [{ ...rule, parameters: { required_status_checks: [{ context: 'missing' }] } }],
      })
    ).toMatchObject({
      state: 'green',
      required: { state: 'pending', counts: { total: 1, pending: 1 } },
    });
  });
  it('cannot satisfy an app-bound requirement with another app or a commit status', async () => {
    expect(
      await verdict({
        protection: legacy,
        runs: [{ ...run, app: { id: 8 } }],
        statuses: [{ id: 1, context: 'build', state: 'success' }],
      })
    ).toMatchObject({ required: { state: 'pending' } });
  });
  it('requires a same-name commit status to pass alongside the bound check run', async () => {
    expect(
      await verdict({
        protection: legacy,
        statuses: [{ id: 1, context: 'build', state: 'failure' }],
      })
    ).toMatchObject({ required: { state: 'red' } });
  });
  it('accepts an unbound legacy context from commit statuses', async () => {
    expect(
      await verdict({
        runs: [],
        protection: { ...legacy, requiredStatusChecks: [{ context: 'build', app: null }] },
        statuses: [{ id: 1, context: 'build', state: 'success' }],
      })
    ).toMatchObject({ required: { state: 'green' } });
  });
  it('retains failed same-name suites and stale conclusions', async () => {
    expect(
      await verdict({
        rules: [rule],
        runs: [run, { ...run, id: 2, check_suite: { id: 2 }, conclusion: 'stale' }],
      })
    ).toMatchObject({ required: { state: 'red', counts: { total: 1, red: 1 } } });
  });
  it('uses the latest rerun inside each suite', async () => {
    expect(
      await verdict({
        rules: [rule],
        runs: [
          { ...run, conclusion: 'failure' },
          { ...run, id: 2 },
        ],
      })
    ).toMatchObject({ required: { state: 'green' } });
  });
  it('paginates inherited rules without applying local branch globs', async () => {
    const { result, paths } = await produce({
      rules: [...Array.from({ length: 100 }, () => ({ type: 'deletion' })), rule],
    });
    expect(result).toMatchObject({
      kind: 'ok',
      value: { required: { state: 'green', counts: { total: 1 } } },
    });
    expect(paths).toContain('/repos/owner/repo/rules/branches/release%2Fqueue?per_page=100&page=2');
  });
  for (const [label, fixture] of Object.entries({
    'legacy 403': { policyHttp: 403 },
    'legacy 404': { policyHttp: 404 },
    'rules 403': { rulesHttp: 403 },
    'rules 404': { rulesHttp: 404 },
    'GraphQL partial data': { graphqlErrors: true },
    'malformed legacy': { protection: {} },
    'missing legacy identities': { protection: { ...legacy, requiredStatusChecks: [] } },
    'malformed rules': { rules: [{ type: 'required_status_checks' }] },
    'wrong legacy branch': { wrongLegacyBase: true },
    'required workflow policy': { rules: [{ type: 'workflows' }] },
    'unrecognized policy': { rules: [{ type: 'future_ci_rule' }], runs: [] },
    'required deployments': { rules: [{ type: 'required_deployments' }] },
  }))
    it(`holds unknown policy for ${label}`, async () => {
      const value = await verdict(fixture);
      expect(value.required).toBeUndefined();
      expect(value.required_policy_error).toBeDefined();
      expect(JSON.stringify(value)).not.toContain('fixture-secret');
    });
  it('refuses base retargeting during enumeration', async () => {
    expect((await produce({ movedBase: true })).result).toMatchObject({
      kind: 'error',
      error: { kind: 'verify_failed' },
    });
  });
});
