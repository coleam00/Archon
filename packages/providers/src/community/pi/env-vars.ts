import { PI_PROVIDER_ENV_VARS } from './pi-vendor-map.generated';

/**
 * Every env var pi-ai reads for a vendor's API key, in pi-ai's own order, or none for a
 * vendor without an API key. A lookup walks this list: an operator who set a fallback
 * name by hand is connected, because pi-ai itself accepts any of them.
 */
export function piEnvVarNames(vendor: string): readonly string[] {
  return PI_PROVIDER_ENV_VARS[vendor] ?? [];
}

/**
 * The one name a delivered credential is written to: the variable pi-ai reads first.
 * Archon delivers one key per vendor, so a write cannot target the whole list.
 */
export function primaryPiEnvVar(vendor: string): string | undefined {
  return PI_PROVIDER_ENV_VARS[vendor]?.[0];
}
