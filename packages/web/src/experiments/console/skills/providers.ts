import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/** Registered AI providers — drives the default-assistant picker + per-provider model rows. */
export type ProviderInfo = components['schemas']['ProviderInfo'];

export function listProviders(): Promise<ProviderInfo[]> {
  return requestJson<components['schemas']['ProviderListResponse']>('/api/providers').then(
    r => r.providers
  );
}

/**
 * One Pi catalog model — drives the cost/reasoning hint next to Pi tier
 * models. Inline-typed until a regen lands PiModelInfo in api.generated
 * (same convention as the tiers block in skills/settings.ts).
 */
export interface PiModelInfo {
  /** Full model ref as used in `model:` fields: '<pi-provider>/<model-id>' */
  ref: string;
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** USD per million tokens. */
  cost: { input: number; output: number };
  contextWindow: number;
}

/** Best-effort: the server returns `{ models: [] }` when the catalog can't load. */
export function listPiModels(): Promise<PiModelInfo[]> {
  return requestJson<{ models: PiModelInfo[] }>('/api/providers/pi/models').then(r => r.models);
}

/**
 * One OpenCode backend provider, introspected from the embedded runtime.
 * Inline-typed (mirrors `opencodeCredentialProviderSchema` in
 * `server/.../provider.schemas.ts`) until a regen lands it in api.generated.
 */
export interface OpencodeCredentialProvider {
  id: string;
  name: string;
  /** Env var names OpenCode reads for this backend. */
  env: string[];
  /** Install-wide: OpenCode's auth store is server-global, not per-user. */
  connected: boolean;
  modelCount: number;
  authMethods: { type: 'oauth' | 'api'; label: string }[];
}

/**
 * GET /api/providers/opencode/credentials — HEAVYWEIGHT: starts the embedded
 * OpenCode runtime when it isn't already up. Call only on explicit user
 * action (card "Load backends" / refresh), never on passive page load.
 * Throws HttpError 503 when the runtime is unavailable.
 */
export function listOpencodeCredentials(): Promise<OpencodeCredentialProvider[]> {
  return requestJson<{ providers: OpencodeCredentialProvider[] }>(
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
