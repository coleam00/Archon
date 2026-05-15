/**
 * Credential Sanitizer
 * Removes sensitive values from strings to prevent credential leaks
 */

const SENSITIVE_ENV_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN'];

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

  // Catch any URL-embedded credentials we might have missed
  result = result.replace(/https:\/\/[^@\s]+@github\.com/g, 'https://[REDACTED]@github.com');
  // GitLab uses oauth2:<token>@host — match any host to cover self-hosted too
  result = result.replace(
    /https:\/\/oauth2:[^@\s]+@[^\s/]+/g,
    'https://oauth2:[REDACTED]@[host]'
  );

  return result;
}

export function sanitizeError(error: Error): Error {
  const sanitized = new Error(sanitizeCredentials(error.message));
  if (error.stack) {
    sanitized.stack = sanitizeCredentials(error.stack);
  }
  return sanitized;
}
