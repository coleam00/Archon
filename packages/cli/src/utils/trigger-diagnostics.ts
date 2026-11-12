import { sanitizeCredentials } from '@archon/core/utils/credential-sanitizer';
import {
  collectCredentialValues,
  redactCredentialValues,
} from '@archon/paths/credential-redaction';

/**
 * Failure messages for the operator's terminal. The store keeps only
 * the failed stage because configuration and provider errors can carry credentials, so
 * the text is redacted with the same policy as subprocess output before it is shown.
 * Flattens the nested `AggregateError`s the drain builds, which carry no reason of their own.
 */
export function redactedFailureReasons(errors: readonly unknown[]): string {
  const messages = (error: unknown): string[] =>
    error instanceof AggregateError
      ? error.errors.flatMap(messages)
      : [error instanceof Error ? error.message : String(error)];
  const credentials = collectCredentialValues(process.env);
  return errors
    .flatMap(messages)
    .map(message => sanitizeCredentials(redactCredentialValues(message, credentials)))
    .join('; ');
}
