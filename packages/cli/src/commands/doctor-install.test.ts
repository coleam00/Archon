import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { removeTempTree } from '@archon/paths/test-utils';
import { checkWorkspaceWritable, checkBundledDefaults, checkTelemetry } from './doctor-install';

describe('checkWorkspaceWritable', () => {
  const TMP = join(tmpdir(), 'archon-doctor-test-' + Date.now());
  let originalHome: string | undefined;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    originalHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = TMP;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.ARCHON_HOME;
    } else {
      process.env.ARCHON_HOME = originalHome;
    }
    await removeTempTree(TMP);
  });

  it('returns pass when directory is writable', async () => {
    const result = await checkWorkspaceWritable();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('writable');
  });

  it('returns pass when directory does not exist (creates it)', async () => {
    rmSync(TMP, { recursive: true, force: true });
    const result = await checkWorkspaceWritable();
    expect(result.status).toBe('pass');
  });
});

describe('checkBundledDefaults', () => {
  it('returns pass with workflow and command counts in dev mode', async () => {
    const result = await checkBundledDefaults();
    expect(result.status).toBe('pass');
    expect(result.label).toBe('Bundled defaults');
    expect(result.message).toMatch(/\d+ workflow/);
    expect(result.message).toMatch(/\d+ command/);
  });
});

describe('checkTelemetry', () => {
  const ENV_VARS = [
    'ARCHON_TELEMETRY_DISABLED',
    'DO_NOT_TRACK',
    'CI',
    'POSTHOG_API_KEY',
    'ARCHON_HOME',
  ] as const;
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_VARS) saved[k] = process.env[k];
    tmpHome = join(tmpdir(), `archon-doctor-tel-${process.pid}-${Date.now()}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env.ARCHON_HOME = tmpHome;
  });

  afterEach(async () => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await removeTempTree(tmpHome);
  });

  it('returns pass when telemetry is enabled', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    const result = await checkTelemetry();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('embedded');
  });

  it('returns skip with CI reason when CI=true', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.env.CI = 'true';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('CI=true');
  });

  it('returns skip with DO_NOT_TRACK reason when opted out', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.CI;
    process.env.DO_NOT_TRACK = '1';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('DO_NOT_TRACK');
  });

  it('returns skip with POSTHOG_API_KEY reason when key set to an off value', async () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'off';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('POSTHOG_API_KEY');
  });

  it('returns skip with ARCHON_TELEMETRY_DISABLED reason when set', async () => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    const result = await checkTelemetry();
    expect(result.status).toBe('skip');
    expect(result.message).toContain('ARCHON_TELEMETRY_DISABLED');
  });
});
