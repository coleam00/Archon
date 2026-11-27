import { describe, expect, mock, test } from 'bun:test';

import { applyPiEnvOverride, type PiAuthEnv } from './auth';
import { piEnvVarNames, primaryPiEnvVar } from './env-vars';

/**
 * Pi 1.6 reads a fallback list for some vendors, such as the Qwen plans: an operator who
 * set the older shared name by hand is connected to Pi, so Archon has to agree. Before the
 * generated map kept the whole list, Archon reported that operator unconnected and never
 * gave Pi the key.
 */
describe('Pi vendor env names', () => {
  test("the generated map keeps pi-ai's whole ordered list", () => {
    expect(piEnvVarNames('qwen-token-plan')).toEqual([
      'QWEN_TOKEN_PLAN_TEAM_API_KEY',
      'QWEN_TOKEN_PLAN_API_KEY',
    ]);
  });

  test('a write targets the first name, and a vendor without a key has none', () => {
    expect(primaryPiEnvVar('qwen-token-plan')).toBe('QWEN_TOKEN_PLAN_TEAM_API_KEY');
    expect(primaryPiEnvVar('amazon-bedrock')).toBeUndefined();
    expect(primaryPiEnvVar('no-such-vendor')).toBeUndefined();
    expect(piEnvVarNames('amazon-bedrock')).toEqual([]);
  });

  test('a turn resolves the key from whichever name carries a value', async () => {
    const setRuntimeApiKey = mock(async (_providerId: string, _key: string) => {});
    const runtime = { setRuntimeApiKey };

    await applyPiEnvOverride(
      runtime,
      'qwen-token-plan',
      authEnv({ QWEN_TOKEN_PLAN_API_KEY: 'legacy-key' }),
      undefined
    );
    expect(setRuntimeApiKey.mock.calls).toEqual([['qwen-token-plan', 'legacy-key']]);

    setRuntimeApiKey.mockClear();
    await applyPiEnvOverride(
      runtime,
      'qwen-token-plan',
      authEnv({ QWEN_TOKEN_PLAN_TEAM_API_KEY: 'team-key' }),
      undefined
    );
    expect(setRuntimeApiKey.mock.calls).toEqual([['qwen-token-plan', 'team-key']]);
  });

  test('the first name wins when both are set, as pi-ai reads them in order', async () => {
    const setRuntimeApiKey = mock(async (_providerId: string, _key: string) => {});
    await applyPiEnvOverride(
      { setRuntimeApiKey },
      'qwen-token-plan',
      authEnv({
        QWEN_TOKEN_PLAN_TEAM_API_KEY: 'team-key',
        QWEN_TOKEN_PLAN_API_KEY: 'legacy-key',
      }),
      undefined
    );
    expect(setRuntimeApiKey.mock.calls).toEqual([['qwen-token-plan', 'team-key']]);
  });
});

function authEnv(credentialEnv: Record<string, string>): PiAuthEnv {
  return {
    credentialEnv,
    credentialValues: Object.values(credentialEnv),
    protectedEnvKeys: undefined,
    deliveredEnvKeys: [],
  };
}
