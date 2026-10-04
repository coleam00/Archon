import type { CredentialSpec, ProviderCredentialCatalog } from './types';

/**
 * Pre-#1955 agent-keyed credential ids → vendor-canonical ids. Accepted at
 * every entry point (connect, delivery, CLI) so in-flight callers and
 * not-yet-migrated rows keep working; storage always uses the vendor id.
 */
export const LEGACY_VENDOR_ALIASES: Readonly<Record<string, string>> = {
  claude: 'anthropic',
  codex: 'openai',
  copilot: 'github-copilot',
};

/** Map a (possibly legacy agent-keyed) credential id to its vendor-canonical id. */
export function normalizeCredentialVendor(id: string): string {
  return LEGACY_VENDOR_ALIASES[id] ?? id;
}

export function singleVendorCatalog(
  spec: CredentialSpec
): Extract<ProviderCredentialCatalog, { kind: 'static' }> {
  return { kind: 'static', specs: [spec], vendorFor: () => spec.vendor };
}
