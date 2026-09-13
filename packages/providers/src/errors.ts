/**
 * Standardized error for unknown provider types.
 * Thrown by getAgentProvider() — all surfaces (CLI, server, orchestrator, workflows)
 * get the same error shape and message format.
 */
export class UnknownProviderError extends Error {
  constructor(
    public readonly requestedProvider: string,
    public readonly registeredProviders: string[]
  ) {
    super(`Unknown provider: '${requestedProvider}'. Available: ${registeredProviders.join(', ')}`);
    this.name = 'UnknownProviderError';
  }
}

/** A provider-owned strict run-config parser rejected one field. */
export class InvalidProviderRunConfigError extends Error {
  constructor(
    public readonly fieldPath: string,
    message: string
  ) {
    super(message);
    this.name = 'InvalidProviderRunConfigError';
  }
}

/** The selected provider cannot delegate its complete tool set to a host. */
export class UnsupportedHostToolsError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider '${provider}' does not support host-owned tools`);
    this.name = 'UnsupportedHostToolsError';
  }
}
