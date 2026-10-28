import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

export function statusDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remote URLs can carry secrets in any component. Git can quote URLs containing
  // literal quotes, so only whitespace safely ends the omission.
  const withoutUrls = message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[URL omitted]');
  return redactCredentialValues(withoutUrls, collectCredentialValues(process.env));
}
