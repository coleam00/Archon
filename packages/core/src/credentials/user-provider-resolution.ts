import {
  getDecryptedProviderCredential,
  listUserProviderKeys,
  type StoredCredential,
} from '../db/user-provider-key-store';
import { normalizeCredentialVendor } from './delivery';

export interface UserProviderCredential {
  provider: string;
  vendor: string;
  stored: StoredCredential;
}

export async function resolveUserProviderCredentials(
  userId: string,
  selectedVendor?: string
): Promise<UserProviderCredential[]> {
  const rows = new Map<string, string>();
  for (const { provider } of await listUserProviderKeys(userId)) {
    const vendor = normalizeCredentialVendor(provider);
    if (selectedVendor !== undefined && vendor !== selectedVendor) continue;
    if (!rows.has(vendor) || provider === vendor) rows.set(vendor, provider);
  }
  return Promise.all(
    [...rows].map(async ([vendor, provider]) => ({
      provider,
      vendor,
      stored: await getDecryptedProviderCredential(userId, provider),
    }))
  );
}
