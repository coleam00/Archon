import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getArchonHome, getTelemetryStatus } from '@archon/paths';
import { doctorLog, type CheckResult } from './doctor-check';

export async function checkWorkspaceWritable(): Promise<CheckResult> {
  const label = 'Workspace';
  const home = getArchonHome();
  const probe = join(home, `.doctor-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(probe, 'ok');
  } catch (err) {
    return { label, status: 'fail', message: `${home} not writable: ${(err as Error).message}` };
  }
  try {
    rmSync(probe, { force: true });
  } catch (err) {
    // Deletion failure is cosmetic — the write succeeded, so the dir is
    // writable. Log so repeated failures leave a diagnostic trace instead of
    // silently accumulating .doctor-probe-* files in ARCHON_HOME.
    doctorLog().warn({ probe, err }, 'doctor.workspace_probe_delete_failed');
  }
  return { label, status: 'pass', message: `${home} is writable` };
}

export async function checkBundledDefaults(): Promise<CheckResult> {
  const label = 'Bundled defaults';
  try {
    const { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS } = await import('@archon/workflows/defaults');
    const commands = Object.keys(BUNDLED_COMMANDS).length;
    const workflows = Object.keys(BUNDLED_WORKFLOWS).length;
    return {
      label,
      status: 'pass',
      message: `${workflows} workflow(s), ${commands} command(s) loaded`,
    };
  } catch (err) {
    return { label, status: 'fail', message: `failed to load: ${(err as Error).message}` };
  }
}

export async function checkTelemetry(): Promise<CheckResult> {
  const label = 'Telemetry';
  const status = getTelemetryStatus();
  if (status.enabled) {
    return {
      label,
      status: 'pass',
      message: `anonymous, ${status.keySource} key (opt out: DO_NOT_TRACK=1)`,
    };
  }
  // `status` is narrowed to the disabled arm here, so `disabledReason` is
  // guaranteed non-null — no fallback branch needed.
  const reasonText: Record<typeof status.disabledReason, string> = {
    ARCHON_TELEMETRY_DISABLED: 'ARCHON_TELEMETRY_DISABLED=1',
    DO_NOT_TRACK: 'DO_NOT_TRACK=1',
    CI: 'CI=true (auto-disabled)',
    POSTHOG_API_KEY: 'POSTHOG_API_KEY set to an opt-out value',
  };
  return { label, status: 'skip', message: `disabled (${reasonText[status.disabledReason]})` };
}
