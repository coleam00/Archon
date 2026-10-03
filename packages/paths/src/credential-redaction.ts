/**
 * Credential redaction for text a subprocess produced: its stdout, its stderr, an error
 * it raised. The values come from the subprocess's own environment, so a credential is
 * removed even when the process echoes it without its env key.
 *
 * One owner for the workflow engine's bash and script output and for provider evidence
 * built from a CLI's stderr: two redactors would drift on which keys count as secret.
 */

const CREDENTIAL_ENV_KEY_SUFFIX = /(?:TOKEN|KEY|SECRET|PASSWORD)$/i;
const CREDENTIAL_ENV_KEYS = new Set(['DATABASE_URL']);

/**
 * The credential values in `env`: secret-named keys, `DATABASE_URL`, and any key in
 * `protectedEnvKeys`, plus `protectedCredentialValues` the caller knows by provenance.
 * Longest first, so a value that contains another is replaced whole.
 */
export function collectCredentialValues(
  env: Readonly<Record<string, string | undefined>>,
  protectedEnvKeys?: readonly string[],
  protectedCredentialValues?: readonly string[]
): string[] {
  const explicitlyProtected = new Set(protectedEnvKeys);
  const values = Object.entries(env).flatMap(([key, value]) =>
    value &&
    (explicitlyProtected.has(key) ||
      CREDENTIAL_ENV_KEYS.has(key) ||
      CREDENTIAL_ENV_KEY_SUFFIX.test(key))
      ? [value]
      : []
  );
  return [...new Set([...values, ...(protectedCredentialValues ?? [])])]
    .filter(value => value.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** `input` with every credential value replaced by `[REDACTED]`. */
export function redactCredentialValues(input: string, credentialValues: readonly string[]): string {
  let result = input;
  for (const value of credentialValues) {
    result = result.replaceAll(value, '[REDACTED]');
  }
  return result;
}
