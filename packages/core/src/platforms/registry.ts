import { identityPlatformSchema } from '../schemas/user';
import type { PlatformPolicy } from './types';

const policies = new Map<string, PlatformPolicy>();

export function registerPlatformPolicy(policy: PlatformPolicy): void {
  identityPlatformSchema.parse(policy.id);
  const existing = policies.get(policy.id);
  if (
    existing &&
    (existing.workspaceRetention !== policy.workspaceRetention ||
      existing.streaming?.defaultMode !== policy.streaming?.defaultMode ||
      existing.streaming?.envVar !== policy.streaming?.envVar)
  ) {
    throw new Error(`Conflicting platform policy for '${policy.id}'`);
  }
  policies.set(policy.id, policy);
}

export function getRegisteredPlatformPolicies(): readonly PlatformPolicy[] {
  return [...policies.values()];
}

export function retainsWorkspace(platformId: string | null): boolean {
  return platformId !== null && policies.get(platformId)?.workspaceRetention === 'retain';
}

export function clearPlatformPolicies(): void {
  policies.clear();
}
