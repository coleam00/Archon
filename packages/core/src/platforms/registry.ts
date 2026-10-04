import { identityPlatformSchema } from '../schemas/user';
import type { PlatformPolicy } from './types';

let configured: readonly PlatformPolicy[] | undefined;

/**
 * Replaces the host's whole policy set. Hosts call this before config loading
 * and cleanup; a host with no chat platforms passes `[]`.
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

export function getRegisteredPlatformPolicies(): readonly PlatformPolicy[] {
  return configured ?? [];
}

/**
 * Platforms whose workspaces age-based cleanup must keep. Throws until the
 * host configured policies: guessing an empty set would delete retained
 * workspaces.
 */
export function retainedPlatformIds(): readonly string[] {
  if (!configured) {
    throw new Error(
      'Platform policies are not configured; call setPlatformPolicies() before cleanup'
    );
  }
  return configured.filter(policy => policy.workspaceRetention === 'retain').map(p => p.id);
}

export function retainsWorkspace(platformId: string | null): boolean {
  const retained = retainedPlatformIds();
  return platformId !== null && retained.includes(platformId);
}

/** Test reset: returns the registry to its unconfigured state. */
export function clearPlatformPolicies(): void {
  configured = undefined;
}
