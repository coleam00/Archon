import type { OAuthCredentials } from './delivery';

export interface OAuthAuthInfo {
  url: string;
  instructions?: string;
}
export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
}
export interface OAuthLoginCallbacks {
  onAuth(info: OAuthAuthInfo): void;
  onDeviceCode(info: OAuthDeviceCodeInfo): void;
  onManualCodeInput(): Promise<string>;
  onPrompt(prompt: unknown): Promise<string>;
  onSelect(prompt: {
    options: readonly { id: string; label?: string }[];
  }): Promise<string | undefined>;
  onProgress?(message: string): void;
  signal?: AbortSignal;
}
export interface SubscriptionOAuthCredentials extends OAuthCredentials {
  type?: 'oauth';
  access: string;
  refresh: string;
  expires: number;
}
export interface OAuthProviderInterface {
  readonly usesCallbackServer?: boolean;
  login(callbacks: OAuthLoginCallbacks): Promise<SubscriptionOAuthCredentials>;
  refreshToken(
    credentials: OAuthCredentials,
    options?: { signal?: AbortSignal }
  ): Promise<SubscriptionOAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): Promise<{ apiKey: string }>;
}

export class SubscriptionOAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null
  ) {
    super(message);
    this.name = 'SubscriptionOAuthError';
  }
}

export class SubscriptionTokenError extends SubscriptionOAuthError {}

export async function subscriptionTokenRequest(
  url: string,
  init: RequestInit,
  operation: string
): Promise<Record<string, unknown>> {
  try {
    return await oauthRequest(url, init, operation);
  } catch (error) {
    if (error instanceof SubscriptionOAuthError)
      throw new SubscriptionTokenError(error.message, error.status);
    throw error;
  }
}

export async function oauthResponse(
  url: string,
  init: RequestInit,
  operation: string
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SubscriptionOAuthError(`${operation} request failed.`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new SubscriptionOAuthError(
      `${operation} failed (HTTP ${response.status}).`,
      response.status,
      response.headers.get('retry-after')
    );
  }
  return response;
}

export async function oauthJson(
  response: Response,
  operation: string
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new SubscriptionOAuthError(`${operation} returned invalid JSON.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SubscriptionOAuthError(`${operation} returned an invalid response.`);
  }
  return raw as Record<string, unknown>;
}

export async function oauthRequest(
  url: string,
  init: RequestInit,
  operation: string
): Promise<Record<string, unknown>> {
  return oauthJson(await oauthResponse(url, init, operation), operation);
}

export function credentialString(credentials: OAuthCredentials, field: string): string {
  const value = credentials[field];
  if (typeof value !== 'string' || !value)
    throw new SubscriptionOAuthError(`Stored subscription credential has no ${field} token.`);
  return value;
}

export async function mintOAuthApiKey(
  provider: OAuthProviderInterface,
  credentials: OAuthCredentials,
  signal?: AbortSignal
): Promise<{ newCredentials: OAuthCredentials; apiKey: string }> {
  if (typeof credentials.expires !== 'number' || !Number.isFinite(credentials.expires)) {
    throw new SubscriptionOAuthError('Stored subscription credential has no valid expiry.');
  }
  const current =
    Date.now() >= credentials.expires
      ? await provider.refreshToken(credentials, { signal })
      : credentials;
  const { apiKey } = await provider.getApiKey(current);
  return { newCredentials: current, apiKey };
}
