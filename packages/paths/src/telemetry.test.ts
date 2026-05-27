import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';

import {
  isTelemetryDisabled,
  captureWorkflowInvoked,
  shutdownTelemetry,
  resetTelemetryForTests,
  getOrCreateTelemetryId,
  getTelemetryStatus,
  resetTelemetryId,
} from './telemetry';

const ENV_VARS = [
  'ARCHON_HOME',
  'ARCHON_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'POSTHOG_API_KEY',
  'POSTHOG_HOST',
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_VARS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe('telemetry opt-out detection', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
  });

  test('enabled by default when no opt-out env vars set', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('CI=true disables telemetry', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.POSTHOG_API_KEY;
    process.env.CI = 'true';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('CI=1 does not disable (only CI=true is honored)', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.POSTHOG_API_KEY;
    process.env.CI = '1';
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('ARCHON_TELEMETRY_DISABLED=1 disables telemetry', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DO_NOT_TRACK=1 disables telemetry', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('ARCHON_TELEMETRY_DISABLED=0 does not disable (strict "1" match)', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '0';
    delete process.env.DO_NOT_TRACK;
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('empty POSTHOG_API_KEY override disables telemetry', () => {
    process.env.POSTHOG_API_KEY = '';
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    expect(isTelemetryDisabled()).toBe(true);
  });

  test.each(['off', 'OFF', '0', 'false', 'disabled'])(
    'POSTHOG_API_KEY=%s disables telemetry',
    value => {
      process.env.POSTHOG_API_KEY = value;
      delete process.env.ARCHON_TELEMETRY_DISABLED;
      delete process.env.DO_NOT_TRACK;
      delete process.env.CI;
      expect(isTelemetryDisabled()).toBe(true);
    }
  );

  test('POSTHOG_API_KEY=phc_custom is treated as enabled (self-host)', () => {
    process.env.POSTHOG_API_KEY = 'phc_custom_self_hosted_key';
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    expect(isTelemetryDisabled()).toBe(false);
  });
});

describe('getTelemetryStatus', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-status-'));
    process.env.ARCHON_HOME = tmpHome;
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('reports enabled + embedded key source when no env vars set', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(true);
    expect(status.disabledReason).toBeNull();
    expect(status.keySource).toBe('embedded');
    expect(status.distinctId).toMatch(/^[0-9a-f-]+$/);
    expect(status.host).toContain('posthog');
  });

  test('reports CI as the disabled reason', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.env.CI = 'true';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toBe('CI');
  });

  test('reports POSTHOG_API_KEY when explicit "off" value is set', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'off';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.disabledReason).toBe('POSTHOG_API_KEY');
    expect(status.keySource).toBe('none');
  });

  test('reports env key source for non-default API key', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'phc_self_hosted';
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(true);
    expect(status.keySource).toBe('env');
  });

  test('precedence: ARCHON_TELEMETRY_DISABLED wins over CI', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    process.env.CI = 'true';
    expect(getTelemetryStatus().disabledReason).toBe('ARCHON_TELEMETRY_DISABLED');
  });
});

describe('resetTelemetryId', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-reset-'));
    process.env.ARCHON_HOME = tmpHome;
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('writes a new UUID to telemetry-id and returns it', () => {
    const id1 = getOrCreateTelemetryId();
    const id2 = resetTelemetryId();
    expect(id2).not.toBe(id1);
    expect(id2).toMatch(/^[0-9a-f-]+$/);
    const onDisk = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(onDisk).toBe(id2);
  });

  test('updates the in-process cache so subsequent calls see the new ID', () => {
    resetTelemetryId();
    const cached = getOrCreateTelemetryId();
    const onDisk = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(cached).toBe(onDisk);
  });
});

describe('captureWorkflowInvoked when disabled', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    resetTelemetryForTests();
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
  });

  test('does not throw when telemetry is disabled', () => {
    expect(() => {
      captureWorkflowInvoked({
        workflowName: 'test-workflow',
        platform: 'cli',
        archonVersion: 'dev',
      });
    }).not.toThrow();
  });

  test('shutdownTelemetry is a no-op when never initialized', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('telemetry ID persistence', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-test-'));
    process.env.ARCHON_HOME = tmpHome;
    // Force-disable actual network capture — we only exercise the ID path.
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('calling capture while disabled does not create a telemetry-id file', () => {
    captureWorkflowInvoked({ workflowName: 'w' });
    expect(existsSync(join(tmpHome, 'telemetry-id'))).toBe(false);
  });

  test('an existing telemetry-id file is preserved (not overwritten)', async () => {
    const { writeFileSync, mkdirSync } = await import('fs');
    const existingId = '11111111-1111-4111-8111-111111111111';
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(join(tmpHome, 'telemetry-id'), existingId, 'utf8');

    resetTelemetryForTests();

    // Direct, synchronous call — no network, no fire-and-forget, no timer.
    const resolved = getOrCreateTelemetryId();

    expect(resolved).toBe(existingId);
    const stored = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(stored).toBe(existingId);
  });
});
