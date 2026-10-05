import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/** Registered AI providers — drives the default-assistant picker + per-provider model rows. */
export type ProviderInfo = components['schemas']['ProviderInfo'];

export function listProviders(): Promise<ProviderInfo[]> {
  return requestJson<components['schemas']['ProviderListResponse']>('/api/providers').then(
    r => r.providers
  );
}

export type PiModelInfo = components['schemas']['PiModelInfo'];

/** Best-effort: the server returns `{ models: [] }` when the catalog can't load. */
export function listPiModels(): Promise<PiModelInfo[]> {
  return requestJson<components['schemas']['PiModelListResponse']>('/api/providers/pi/models').then(
    r => r.models
  );
}

export type OpencodeCredentialProvider = components['schemas']['OpencodeCredentialProvider'];

/**
 * GET /api/providers/opencode/credentials — HEAVYWEIGHT: starts the embedded
 * OpenCode runtime when it isn't already up. Call only on explicit user
 * action (card "Load backends" / refresh), never on passive page load.
 * Throws HttpError 503 when the runtime is unavailable.
 */
export function listOpencodeCredentials(): Promise<OpencodeCredentialProvider[]> {
  return requestJson<components['schemas']['OpencodeCredentialListResponse']>(
    '/api/providers/opencode/credentials'
  ).then(r => r.providers);
}

/**
 * Client-side deadline for `listOpencodeCredentials` callers: booting the
 * embedded OpenCode runtime is the slow path, so give it a generous minute
 * before declaring the load hung — the user always gets a Retry escape
 * instead of a permanent "Loading…".
 */
export const OPENCODE_LOAD_TIMEOUT_MS = 60_000;
