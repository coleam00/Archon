/**
 * Credential Sanitizer
 * Removes sensitive values from strings to prevent credential leaks
 */

const SENSITIVE_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITEA_TOKEN'];

// GitHub token prefixes (OAuth user tokens, GitHub App tokens, PATs, refresh tokens)
const GITHUB_TOKEN_RE = /\b(ghu|ghs|ghp|gho|ghr)_[A-Za-z0-9_]{20,}\b/g;
// Fine-grained personal access tokens
const GITHUB_FINE_GRAINED_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g;
// Archon internal per-repo tokens (hex-encoded, 64 chars)
const ART_TOKEN_RE = /\bart_[0-9a-f]{64}\b/g;
// HTTP Basic auth blobs: "Basic <base64(user:token)>" — matches padded and unpadded
const BASIC_AUTH_RE = /\bBasic [A-Za-z0-9+/=]+/g;
// HTTP Bearer tokens
const BEARER_AUTH_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeCredentials(input: string): string {
  let result = input;

  for (const envVar of SENSITIVE_ENV_VARS) {
    const value = process.env[envVar];
    if (value && value.length > 0) {
      result = result.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]');
    }
  }

  // Redact GitHub token formats by prefix pattern (catches per-user tokens in logs)
  result = result.replace(GITHUB_TOKEN_RE, '[REDACTED]');
  result = result.replace(GITHUB_FINE_GRAINED_PAT_RE, '[REDACTED]');
  // Redact Archon internal tokens
  result = result.replace(ART_TOKEN_RE, '[REDACTED]');
  // Redact Base64 Basic auth blobs (e.g. from http.extraHeader logs)
  result = result.replace(BASIC_AUTH_RE, 'Basic [REDACTED]');
  // Redact Bearer auth tokens
  result = result.replace(BEARER_AUTH_RE, 'Bearer [REDACTED]');

  // Catch any URL-embedded credentials we might have missed. Since #1658
  // clone URLs can embed tokens on ANY host (oauth2:<token>@gitlab.example.com,
  // <token>@gitea.example.com), so redact the whole userinfo (user[:pass]) of
  // any scheme://userinfo@host form — the username itself can be the token —
  // while keeping scheme and host for debugging. `[^@/\s]+` cannot cross a
  // `/`, so URLs without embedded credentials are left untouched.
  result = result.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/\s]+@/g, '$1[REDACTED]@');

  return result;
}

export function sanitizeError(error: Error): Error {
  const sanitized = new Error(sanitizeCredentials(error.message));
  if (error.stack) {
    sanitized.stack = sanitizeCredentials(error.stack);
  }
  return sanitized;
}
