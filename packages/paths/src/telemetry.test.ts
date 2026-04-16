import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';

import {
  isTelemetryDisabled,
  captureWorkflowInvoked,
  shutdownTelemetry,
  resetTelemetryForTests,
} from './telemetry';

const ENV_VARS = [
  'ARCHON_HOME',
  'ARCHON_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
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
    delete process.env.POSTHOG_API_KEY;
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
    expect(isTelemetryDisabled()).toBe(true);
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
        workflowDescription: 'A test',
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
    // Simulate a prior run by writing a UUID, then enable the capture path so
    // lazy init exercises the id-read. We redirect POSTHOG_HOST to a
    // guaranteed-unreachable loopback port so the client's flush fails
    // silently (swallowed by our error hook) instead of leaking a test event
    // to production PostHog.
    const { writeFileSync, mkdirSync } = await import('fs');
    const existingId = '11111111-1111-4111-8111-111111111111';
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(join(tmpHome, 'telemetry-id'), existingId, 'utf8');

    delete process.env.ARCHON_TELEMETRY_DISABLED;
    process.env.POSTHOG_HOST = 'http://127.0.0.1:1';
    resetTelemetryForTests();

    captureWorkflowInvoked({ workflowName: 'w' });

    // Give the async capture a moment to run its file read.
    await new Promise(resolve => setTimeout(resolve, 20));

    const stored = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(stored).toBe(existingId);

    // Clean up any in-flight client (silentFetch masks the unreachable host
    // as a 200, so shutdown completes immediately).
    await shutdownTelemetry();
  });
});
