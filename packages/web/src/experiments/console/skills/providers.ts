import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/** Registered AI providers — drives the default-assistant picker + per-provider model rows. */
export type ProviderInfo = components['schemas']['ProviderInfo'];

export function listProviders(): Promise<ProviderInfo[]> {
  return requestJson<components['schemas']['ProviderListResponse']>('/api/providers').then(
    r => r.providers
  );
}
