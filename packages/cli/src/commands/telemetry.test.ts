import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { telemetryStatusCommand, telemetryResetCommand } from './telemetry';

const ENV_VARS = [
  'ARCHON_HOME',
  'ARCHON_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'CI',
  'POSTHOG_API_KEY',
  'POSTHOG_HOST',
] as const;

describe('telemetryStatusCommand', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;
  let logSpy: ReturnType<typeof spyOn<Console, 'log'>>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_VARS) saved[k] = process.env[k];
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-cli-telemetry-'));
    process.env.ARCHON_HOME = tmpHome;
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    logSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function output(): string {
    return logSpy.mock.calls.flat().join('\n');
  }

  it('returns 0 and prints enabled state + opt-out hint when telemetry is on', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    delete process.env.POSTHOG_API_KEY;
    expect(telemetryStatusCommand()).toBe(0);
    const out = output();
    expect(out).toContain('Telemetry:   enabled');
    expect(out).toContain('DO_NOT_TRACK=1');
  });

  it('prints the ARCHON_TELEMETRY_DISABLED reason and no opt-out hint when disabled', () => {
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(telemetryStatusCommand()).toBe(0);
    const out = output();
    expect(out).toContain('Telemetry:   disabled');
    expect(out).toContain('ARCHON_TELEMETRY_DISABLED=1 is set');
    expect(out).not.toContain('Opt out anytime');
  });

  it('prints the CI reason when CI=true', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    process.env.CI = 'true';
    telemetryStatusCommand();
    expect(output()).toContain('CI=true detected');
  });

  it('prints the POSTHOG_API_KEY reason when set to an off value', () => {
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    process.env.POSTHOG_API_KEY = 'off';
    telemetryStatusCommand();
    expect(output()).toContain('POSTHOG_API_KEY is set to an opt-out value');
  });
});

describe('telemetryResetCommand', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_VARS) saved[k] = process.env[k];
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-cli-telemetry-reset-'));
    process.env.ARCHON_HOME = tmpHome;
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns 0 and prints the new UUID on success', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    expect(telemetryResetCommand()).toBe(0);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('Rotated install UUID');
    logSpy.mockRestore();
  });

  it('returns 1 and prints an error when the id file cannot be written', () => {
    // Point ARCHON_HOME under a regular file so mkdir/write fails (ENOTDIR).
    const filePath = join(tmpdir(), `archon-tel-notdir-${process.pid}-${tmpHome.length}`);
    writeFileSync(filePath, 'x', 'utf8');
    process.env.ARCHON_HOME = join(filePath, 'nested');
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    expect(telemetryResetCommand()).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('failed to rotate telemetry ID');
    errSpy.mockRestore();
    rmSync(filePath, { force: true });
  });
});
