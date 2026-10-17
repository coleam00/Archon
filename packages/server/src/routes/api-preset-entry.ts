import { missingProviderMessage } from '@archon/provider-contract';
import { isRegisteredProvider, providerRegistry } from '@archon/providers';
import { validEffortsForProvider } from '@archon/workflows/model-validation';
import type { EffortLevel } from '@archon/workflows/schemas/effort';

/** Validate a tier/alias entry's provider + effort. Returns an error message or null. */
export function validatePresetEntry(
  label: string,
  entry: { provider: string; model: string; effort?: EffortLevel }
): string | null {
  if (!isRegisteredProvider(entry.provider)) {
    return `${label}: ${missingProviderMessage(providerRegistry, entry.provider)}`;
  }
  if (entry.effort !== undefined) {
    const validEfforts = validEffortsForProvider(providerRegistry, entry.provider);
    if (validEfforts === null) {
      return `Provider '${entry.provider}' does not support effort (${label}).`;
    }
    if (!validEfforts.includes(entry.effort)) {
      return (
        `Invalid effort '${entry.effort}' for provider '${entry.provider}' (${label}). ` +
        `Valid: ${validEfforts.join(', ')}`
      );
    }
  }
  return null;
}

export function toCleanEntry(entry: { provider: string; model: string; effort?: EffortLevel }): {
  provider: string;
  model: string;
  effort?: EffortLevel;
} {
  return {
    provider: entry.provider,
    model: entry.model,
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
  };
}
