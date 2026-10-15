/**
 * The user connected a credential for the vendor a turn needs, and it cannot be used.
 * The turn stops rather than run on whatever login the host has. `reason` is a status
 * evidence or delivery message, never a credential value, so the message is shown as is.
 */
export class ConnectedCredentialUnavailableError extends Error {
  constructor(
    readonly vendor: string,
    reason: string
  ) {
    super(
      `Your connected ${vendor} credential cannot be used: ${reason} ` +
        'Reconnect it in Settings → Agents, then try again. ' +
        'The message was not sent, so it did not run on another account.'
    );
    this.name = 'ConnectedCredentialUnavailableError';
  }
}
