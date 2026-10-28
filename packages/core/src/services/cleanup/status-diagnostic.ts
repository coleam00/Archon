import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

export function statusDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remote URLs can carry secrets in userinfo, paths, queries or fragments. Keep
  // the surrounding failure evidence, but omit the complete URL from status/logs.
  const withoutUrls = message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[URL omitted]');
  return redactCredentialValues(withoutUrls, collectCredentialValues(process.env));
}
