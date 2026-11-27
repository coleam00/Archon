/**
 * The class of a failed Pi turn, read from the status its error message starts with.
 *
 * Pi gives the event bridge no typed error: a failed `AssistantMessage` carries `stopReason`
 * and `errorMessage`, and `formatProviderError` folds the status it computed into the message as
 * `"<status>: <body>"`. That is the SDK's own normalisation, so only the leading token is read —
 * never the body, and never a vendor's wording. The class then comes from the shared status
 * table, never from the text.
 *
 * This one read is the deliberate exception to "a token from provider output never decides a
 * retry", granted for this adapter alone while the SDK exposes nothing better. Delete this file
 * and use the typed field when https://github.com/earendil-works/pi/issues/11071 lands one.
 */
import type { ProviderFailureClass } from '@archon/provider-contract';
import { classOfHttpStatus } from '../../shared/failure';

/** A status where the text starts; a status quoted later in prose is not matched. */
const LEADING_HTTP_STATUS = /^(\d{3})\b/;

export function failureClassFromMessage(message: string | undefined): ProviderFailureClass {
  const match = LEADING_HTTP_STATUS.exec(message ?? '');
  if (!match) return 'unknown';
  return classOfHttpStatus(Number(match[1]));
}
