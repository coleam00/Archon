export type ProviderName = 'claude' | 'codex';

export type RefreshFailureReason =
  | 'no_creds'
  | 'no_refresh_token'
  | 'refresh_expired'
  | 'refresh_revoked'
  | 'refresh_reused'
  | 'network'
  | 'unknown';

export type RefreshResult =
  | { refreshed: true; expiresAt: number }
  | { refreshed: false; reason: RefreshFailureReason; error?: Error };

export interface ClaudeCreds {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
    rateLimitTier: string;
  };
  mcpOAuth?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexCreds {
  OPENAI_API_KEY: null | string;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string;
  [key: string]: unknown;
}

export interface LockHandle {
  path: string;
  release(): void;
}
