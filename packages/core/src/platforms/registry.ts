import { identityPlatformSchema } from '../schemas/user';
import type { PlatformPolicy } from './types';

let configured: readonly PlatformPolicy[] | undefined;

/**
 * Replaces the host's whole policy set. Hosts call this before config loading
 * and cleanup, including policies for their non-chat surfaces.
 */
export function setPlatformPolicies(list: readonly PlatformPolicy[]): void {
  const ids = new Set<string>();
  for (const policy of list) {
    identityPlatformSchema.parse(policy.id);
    if (ids.has(policy.id)) throw new Error(`Duplicate platform policy for '${policy.id}'`);
    ids.add(policy.id);
  }
  configured = [...list];
}

/**
 * Throws until the host configures policies: an empty fallback would drop
 * streaming defaults and env overrides, and make cleanup report known platforms
 * as unregistered.
 */
export function getRegisteredPlatformPolicies(): readonly PlatformPolicy[] {
  if (!configured) {
    throw new Error(
      'Platform policies are not configured; call setPlatformPolicies() before loading config or running cleanup'
    );
  }
  return configured;
}

function getPlatformPolicy(platformId: string | null): PlatformPolicy | undefined {
  return getRegisteredPlatformPolicies().find(policy => policy.id === platformId);
}

export function retainsWorkspace(platformId: string | null): boolean {
  return getPlatformPolicy(platformId)?.workspaceRetention === 'retain';
}

/** Test reset: returns the registry to its unconfigured state. */
export function clearPlatformPolicies(): void {
  configured = undefined;
}

export type UnknownPlatformReason =
  `platform '${string}' is not registered; workspace kept (plugin may have been removed)`;

export function unknownPlatformReason(
  platformId: string | null
): UnknownPlatformReason | undefined {
  if (platformId === null || getPlatformPolicy(platformId)) return undefined;
  return `platform '${platformId}' is not registered; workspace kept (plugin may have been removed)`;
}
