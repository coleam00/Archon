/**
 * `archon telemetry` subcommands.
 *
 * `status` — print the current telemetry state (enabled/disabled, reason,
 * distinct ID, host, key source). Useful for users who want to verify their
 * opt-out is wired correctly without grepping env vars.
 *
 * `reset` — rotate the persisted install UUID at `${ARCHON_HOME}/telemetry-id`.
 * The previous ID is overwritten and not recoverable. Useful when a user wants
 * to "start fresh" for privacy reasons or when copying an install image.
 */
import { getTelemetryStatus, resetTelemetryId, type TelemetryStatus } from '@archon/paths';

function formatStatus(status: TelemetryStatus): string {
  const lines: string[] = [];
  lines.push(`Telemetry:   ${status.enabled ? 'enabled' : 'disabled'}`);
  if (!status.enabled) {
    // Narrowed to the disabled arm: `disabledReason` is guaranteed non-null.
    const explanation: Record<typeof status.disabledReason, string> = {
      ARCHON_TELEMETRY_DISABLED: 'ARCHON_TELEMETRY_DISABLED=1 is set',
      DO_NOT_TRACK: 'DO_NOT_TRACK=1 is set',
      CI: 'CI=true detected (auto-disabled in CI environments)',
      POSTHOG_API_KEY: 'POSTHOG_API_KEY is set to an opt-out value (off/0/false/disabled/empty)',
    };
    lines.push(`Reason:      ${explanation[status.disabledReason]}`);
  }
  lines.push(`Distinct ID: ${status.distinctId}`);
  lines.push(`Host:        ${status.host}`);
  lines.push(`Key source:  ${status.keySource}`);
  return lines.join('\n');
}

export function telemetryStatusCommand(): number {
  const status = getTelemetryStatus();
  console.log(formatStatus(status));
  if (status.enabled) {
    console.log('\nOpt out anytime: DO_NOT_TRACK=1 or ARCHON_TELEMETRY_DISABLED=1');
  }
  return 0;
}

export function telemetryResetCommand(): number {
  try {
    const newId = resetTelemetryId();
    console.log(`Rotated install UUID. New ID: ${newId}`);
    return 0;
  } catch (error) {
    const err = error as Error;
    console.error(`Error: failed to rotate telemetry ID: ${err.message}`);
    return 1;
  }
}
