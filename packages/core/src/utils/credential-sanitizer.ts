/**
 * Credential Sanitizer
 * Removes sensitive values from strings to prevent credential leaks
 */

import { redactSecrets } from '@archon/providers/types';

const SENSITIVE_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITEA_TOKEN'];

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

  // Value-independent shapes. The env-var loop above can only redact what is in
  // THIS process's environment; per-user provider credentials are decrypted from
  // the credential store at dispatch time and never enter it, so that loop cannot
  // see them. Shared with the container exec path — see @archon/providers.
  result = redactSecrets(result);

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
