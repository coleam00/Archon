import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { ProviderCodexRateLimitRequest } from '../types';
import { invalidateCodexRateLimitCache, readCodexRateLimit } from './rate-limits';

const trackTempRoot = trackTempRoots();

interface FakeProfile {
  home: string;
  binaryPath: string;
  capturePath: string;
}

async function createFakeProfile(response: Record<string, unknown>): Promise<FakeProfile> {
  const root = trackTempRoot(await mkdtemp(path.join(os.tmpdir(), 'archon-codex-quota-')));
  const home = path.join(root, 'codex-home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(
    path.join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: 'fixture-access-token',
        refresh_token: 'fixture-refresh-token',
        account_id: 'account-a',
      },
    }),
    { mode: 0o600 }
  );
  const capturePath = path.join(root, 'environment.jsonl');
  const binaryPath = path.join(root, 'fake-codex-app-server.js');
  const script = [
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    `const quotaResponse = ${JSON.stringify(response)};`,
    'const lines = readline.createInterface({ input: process.stdin });',
    "lines.on('line', line => {",
    '  const request = JSON.parse(line);',
    "  if (typeof request.id !== 'number') return;",
    '  fs.appendFileSync(process.env.CAPTURE_FILE, JSON.stringify({',
    '    method: request.method,',
    '    codexHome: process.env.CODEX_HOME,',
    '    openAiKey: process.env.OPENAI_API_KEY,',
    "  }) + '\\n');",
    "  const result = request.method === 'account/rateLimits/read' ? quotaResponse : {};",
    "  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');",
    '});',
  ].join('\n');
  await writeFile(binaryPath, script, { mode: 0o600 });
  return { home, binaryPath, capturePath };
}

function makeRequest(profile: FakeProfile, overrides: Partial<ProviderCodexRateLimitRequest> = {}) {
  return {
    limitId: 'five_hour',
    expectedAccountId: 'account-a',
    cacheScope: `test-codex-scope-${crypto.randomUUID()}`,
    cwd: profile.home,
    options: {
      assistantConfig: { codexBinaryPath: profile.binaryPath },
      env: {
        CODEX_HOME: profile.home,
        OPENAI_API_KEY: 'ambient-key-must-not-be-forwarded',
        CAPTURE_FILE: profile.capturePath,
      },
      protectedEnvKeys: ['CODEX_HOME'],
      codexAuthProfile: { kind: 'user-oauth' as const, accountId: 'account-a' },
    },
    ...overrides,
  } satisfies ProviderCodexRateLimitRequest;
}

describe('readCodexRateLimit', () => {
  test('reads the exact OAuth account and configured bucket without forwarding ambient API keys', async () => {
    invalidateCodexRateLimitCache();
    const profile = await createFakeProfile({
      accountId: 'account-a',
      ordinaryUsageAllowed: false,
      rateLimitsByLimitId: {
        five_hour: { limitId: 'five_hour', rateLimitReachedType: null },
        seven_day: { limitId: 'seven_day', rateLimitReachedType: null },
      },
    });
    const request = makeRequest(profile);

    const first = await readCodexRateLimit(request);
    const second = await readCodexRateLimit(request);

    expect(first).toMatchObject({ limitId: 'five_hour', exhausted: true });
    expect(second).toEqual(first);
    const captured = (await Bun.file(profile.capturePath).text())
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(captured).toHaveLength(2);
    expect(captured.map(line => line.method)).toEqual(['initialize', 'account/rateLimits/read']);
    expect(captured.every(line => line.codexHome === profile.home)).toBe(true);
    expect(captured.every(line => line.openAiKey === undefined)).toBe(true);

    invalidateCodexRateLimitCache();
    await expect(readCodexRateLimit(request)).resolves.toMatchObject({
      limitId: 'five_hour',
      exhausted: true,
    });
    expect((await Bun.file(profile.capturePath).text()).trim().split('\n')).toHaveLength(4);
  });

  test('treats a known allowed bucket as available and a provider-reported exhausted bucket as exhausted', async () => {
    invalidateCodexRateLimitCache();
    const availableProfile = await createFakeProfile({
      accountId: 'account-a',
      ordinaryUsageAllowed: true,
      rateLimitsByLimitId: {
        five_hour: { limitId: 'five_hour', rateLimitReachedType: null },
      },
    });
    await expect(readCodexRateLimit(makeRequest(availableProfile))).resolves.toMatchObject({
      limitId: 'five_hour',
      exhausted: false,
    });

    invalidateCodexRateLimitCache();
    const exhaustedProfile = await createFakeProfile({
      accountId: 'account-a',
      rateLimitsByLimitId: {
        five_hour: { limitId: 'five_hour', rateLimitReachedType: 'rate_limit_reached' },
      },
    });
    await expect(readCodexRateLimit(makeRequest(exhaustedProfile))).resolves.toMatchObject({
      limitId: 'five_hour',
      exhausted: true,
    });
  });

  test('fails closed for account, bucket, reached-type, and unknown-usage mismatches', async () => {
    const responses = [
      {
        accountId: 'different-account',
        ordinaryUsageAllowed: false,
        rateLimitsByLimitId: { five_hour: { limitId: 'five_hour' } },
      },
      {
        accountId: 'account-a',
        ordinaryUsageAllowed: false,
        rateLimitsByLimitId: { seven_day: { limitId: 'seven_day' } },
      },
      {
        accountId: 'account-a',
        ordinaryUsageAllowed: false,
        rateLimitsByLimitId: {
          five_hour: { limitId: 'five_hour', rateLimitReachedType: 'unknown-provider-value' },
        },
      },
      {
        accountId: 'account-a',
        rateLimitsByLimitId: { five_hour: { limitId: 'five_hour' } },
      },
    ];

    for (const response of responses) {
      invalidateCodexRateLimitCache();
      const profile = await createFakeProfile(response);
      await expect(readCodexRateLimit(makeRequest(profile))).resolves.toBeUndefined();
    }
  });

  test('refuses a mismatched declared profile or auth-file account before spawning', async () => {
    invalidateCodexRateLimitCache();
    const profile = await createFakeProfile({
      accountId: 'account-a',
      ordinaryUsageAllowed: true,
      rateLimitsByLimitId: { five_hour: { limitId: 'five_hour' } },
    });
    const mismatchedMetadata = makeRequest(profile, {
      expectedAccountId: 'account-b',
      options: {
        ...makeRequest(profile).options,
        codexAuthProfile: { kind: 'user-oauth', accountId: 'account-b' },
      },
    });
    await expect(readCodexRateLimit(mismatchedMetadata)).resolves.toBeUndefined();

    const auth = JSON.parse(await Bun.file(path.join(profile.home, 'auth.json')).text()) as {
      tokens: Record<string, unknown>;
    };
    auth.tokens.account_id = 'account-b';
    await writeFile(path.join(profile.home, 'auth.json'), JSON.stringify(auth));
    await expect(readCodexRateLimit(makeRequest(profile))).resolves.toBeUndefined();
    expect(await Bun.file(profile.capturePath).exists()).toBe(false);
  });
});
