/**
 * Why a user's connected credential cannot be used right now. `reason` is a status
 * evidence or delivery message, never a credential value. `retryable` is true when the
 * check could not decide (a refresh that failed for a network, outage or rate-limit
 * cause), so trying again can work; otherwise the credential itself is broken.
 */
export interface CredentialFailure {
  reason: string;
  retryable: boolean;
}

/**
 * The user connected a credential for the vendor a turn needs, and it cannot be used.
 * The turn stops rather than run on whatever login the host has. The message carries
 * no secret, so it is shown as is.
 */
export class ConnectedCredentialUnavailableError extends Error {
  constructor(
    readonly vendor: string,
    failure: CredentialFailure
  ) {
    const action = failure.retryable
      ? 'Try again in a moment; if it keeps failing, reconnect it in Settings → Agents.'
      : 'Reconnect it in Settings → Agents, then try again.';
    super(
      `Your connected ${vendor} credential cannot be used: ${failure.reason} ${action} ` +
        'The message was not sent, so it did not run on another account.'
    );
    this.name = 'ConnectedCredentialUnavailableError';
  }
}
